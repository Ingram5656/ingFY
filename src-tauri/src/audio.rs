//! 拾音：采集电脑正在播放的声音（WASAPI 回环），做频谱分析，推给前端驱动拾音灯。
//!
//! - 采集：在默认输出设备上建"输入流"，cpal 在 WASAPI 下会自动用回环模式，
//!   拿到的就是扬声器/耳机里正在放的声音，和用哪个播放器无关。
//! - 分析：每秒约 40 次，取最近 2048 个采样，加汉宁窗做 FFT，
//!   按对数频率分成 64 段（40Hz~16kHz），换算成分贝后做自动增益和起落平滑。
//! - 推送：事件 "audio-levels"，内容是 64 个 0~255 的整数。
//! - 主窗口和桌面歌词都藏起来（缩到托盘）时不做 FFT、不推送，只留采集，省 CPU。
//! - 换了输出设备（比如插上耳机）或设备出错时会自动重连。

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustfft::{num_complex::Complex, FftPlanner};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const BANDS: usize = 64;
const FFT_SIZE: usize = 2048;
const MIN_FREQ: f32 = 40.0;
const MAX_FREQ: f32 = 16_000.0;
const FRAME: Duration = Duration::from_millis(25);

struct Shared {
    samples: VecDeque<f32>,
    sample_rate: f32,
    last_push: Instant,
}

/// 启动采集和分析线程
pub fn start(app: AppHandle) {
    let shared = Arc::new(Mutex::new(Shared {
        samples: VecDeque::with_capacity(FFT_SIZE * 2),
        sample_rate: 48_000.0,
        last_push: Instant::now(),
    }));

    // 采集线程：cpal 的 Stream 不能跨线程，所以建流、保活、重连都在这个线程里
    {
        let shared = shared.clone();
        std::thread::spawn(move || capture_loop(shared));
    }
    // 分析线程
    std::thread::spawn(move || analyze_loop(app, shared));
}

fn device_name(d: &cpal::Device) -> String {
    d.name().unwrap_or_default()
}

fn capture_loop(shared: Arc<Mutex<Shared>>) {
    loop {
        let failed = Arc::new(AtomicBool::new(false));
        match open_stream(shared.clone(), failed.clone()) {
            Ok((stream, name)) => {
                // 保持流运行；每 2 秒检查一次默认设备有没有换、流有没有出错
                loop {
                    std::thread::sleep(Duration::from_secs(2));
                    let current = cpal::default_host()
                        .default_output_device()
                        .map(|d| device_name(&d))
                        .unwrap_or_default();
                    if failed.load(Ordering::Relaxed) || current != name {
                        break;
                    }
                }
                drop(stream);
            }
            Err(e) => {
                eprintln!("[拾音] 打开音频设备失败：{e}，3 秒后重试");
                std::thread::sleep(Duration::from_secs(3));
            }
        }
    }
}

fn open_stream(
    shared: Arc<Mutex<Shared>>,
    failed: Arc<AtomicBool>,
) -> Result<(cpal::Stream, String), String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("没有找到输出设备")?;
    let name = device_name(&device);
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    shared.lock().unwrap().sample_rate = supported.sample_rate().0 as f32;
    let config: cpal::StreamConfig = supported.into();

    let on_error = {
        let failed = failed.clone();
        move |e: cpal::StreamError| {
            eprintln!("[拾音] 音频流出错：{e}");
            failed.store(true, Ordering::Relaxed);
        }
    };

    // 把多声道混成单声道写进环形缓冲
    fn push<T: Copy>(shared: &Arc<Mutex<Shared>>, data: &[T], channels: usize, to_f32: impl Fn(T) -> f32) {
        let mut s = shared.lock().unwrap();
        for frame in data.chunks(channels.max(1)) {
            let sum: f32 = frame.iter().map(|&x| to_f32(x)).sum();
            s.samples.push_back(sum / frame.len() as f32);
        }
        while s.samples.len() > FFT_SIZE * 2 {
            s.samples.pop_front();
        }
        s.last_push = Instant::now();
    }

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let sh = shared.clone();
            device.build_input_stream(&config, move |d: &[f32], _: &_| push(&sh, d, channels, |x| x), on_error, None)
        }
        cpal::SampleFormat::I16 => {
            let sh = shared.clone();
            device.build_input_stream(
                &config,
                move |d: &[i16], _: &_| push(&sh, d, channels, |x| x as f32 / i16::MAX as f32),
                on_error,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let sh = shared.clone();
            device.build_input_stream(
                &config,
                move |d: &[u16], _: &_| push(&sh, d, channels, |x| (x as f32 - 32768.0) / 32768.0),
                on_error,
                None,
            )
        }
        other => return Err(format!("不支持的采样格式 {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, name))
}

fn analyze_loop(app: AppHandle, shared: Arc<Mutex<Shared>>) {
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
    let hann: Vec<f32> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE as f32 - 1.0)).cos())
        .collect();
    let mut buf = vec![Complex { re: 0.0f32, im: 0.0f32 }; FFT_SIZE];
    let mut smooth = [0.0f32; BANDS];
    let mut peak = 0.35f32;
    let mut last_sent = [0u8; BANDS];
    let mut any_visible = true;
    let mut last_vis_check: Option<Instant> = None;

    loop {
        let started = Instant::now();

        // 每半秒看一次有没有窗口在显示；都藏起来了就歇着，不做 FFT 也不往网页里推数据
        if last_vis_check.map_or(true, |t| t.elapsed() >= Duration::from_millis(500)) {
            last_vis_check = Some(Instant::now());
            any_visible = app
                .webview_windows()
                .values()
                .any(|w| w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false));
        }
        if !any_visible {
            smooth = [0.0; BANDS];
            // 下次显示时先推一帧，免得灯停在藏起来之前的高度
            last_sent = [255u8; BANDS];
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }
        let (samples, sample_rate, stale) = {
            let s = shared.lock().unwrap();
            let n = s.samples.len();
            let take: Vec<f32> = s.samples.iter().skip(n.saturating_sub(FFT_SIZE)).copied().collect();
            // 没有声音时 WASAPI 回环不会送数据，超过 200ms 没新数据就当作静音
            (take, s.sample_rate, s.last_push.elapsed() > Duration::from_millis(200))
        };

        let mut target = [0.0f32; BANDS];
        if !stale && samples.len() == FFT_SIZE {
            for i in 0..FFT_SIZE {
                buf[i] = Complex { re: samples[i] * hann[i], im: 0.0 };
            }
            fft.process(&mut buf);

            let bin_hz = sample_rate / FFT_SIZE as f32;
            let ratio = MAX_FREQ / MIN_FREQ;
            for b in 0..BANDS {
                let f_lo = MIN_FREQ * ratio.powf(b as f32 / BANDS as f32);
                let f_hi = MIN_FREQ * ratio.powf((b + 1) as f32 / BANDS as f32);
                let lo = ((f_lo / bin_hz) as usize).max(1);
                let hi = ((f_hi / bin_hz).ceil() as usize).clamp(lo + 1, FFT_SIZE / 2);
                let mag = buf[lo..hi].iter().map(|c| c.norm()).fold(0.0f32, f32::max);
                let db = 20.0 * (mag / (FFT_SIZE as f32 / 4.0) + 1e-9).log10();
                // 高频能量天然低，按每倍频程 +3dB 补偿，让频谱看起来更平均
                let octaves = ((f_lo + f_hi) * 0.5 / 1000.0).log2();
                let tilt = octaves * 3.0;
                target[b] = ((db + tilt + 62.0) / 52.0).clamp(0.0, 1.0);
            }

            // 自动增益：音量大小不同的歌，灯的高度都差不多
            let frame_max = target.iter().copied().fold(0.0f32, f32::max);
            peak = frame_max.max(peak * 0.996).max(0.35);
            let gain = 0.92 / peak;
            for v in target.iter_mut() {
                *v = (*v * gain).clamp(0.0, 1.0).powf(1.4);
            }
        }

        // 起快落慢，灯跳得有弹性又不抖
        for b in 0..BANDS {
            let k = if target[b] > smooth[b] { 0.65 } else { 0.16 };
            smooth[b] += (target[b] - smooth[b]) * k;
        }

        let out: [u8; BANDS] = std::array::from_fn(|b| (smooth[b] * 255.0).round() as u8);
        // 完全静音且已经落到底时不再重复推送，省一点开销
        if out != last_sent || out.iter().any(|&v| v > 0) {
            let _ = app.emit("audio-levels", out.to_vec());
            last_sent = out;
        }

        if let Some(rest) = FRAME.checked_sub(started.elapsed()) {
            std::thread::sleep(rest);
        }
    }
}
