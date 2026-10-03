//! Native audio formats and transport fixtures from audio.test.ts, ears.test.ts and video.test.ts.
use futures::FutureExt;
use kumi_runtime::{
    audio::decode::open_audio,
    ears::{capture::*, osc::*},
    video::programs::*,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

fn tone(length: usize, hz: f64, amplitude: f64) -> Vec<f32> {
    (0..length).map(|i| (amplitude * (2.0 * std::f64::consts::PI * hz * i as f64 / 48000.0).sin()) as f32).collect()
}
fn wav(path: &Path, channels: &[Vec<f32>], bits: u16) {
    let bytes = bits / 8;
    let size = (channels[0].len() * channels.len() * bytes as usize) as u32;
    let mut out = Vec::new();
    out.extend(b"RIFF");
    out.extend((size + 36).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend((if bits == 32 { 3u16 } else { 1u16 }).to_le_bytes());
    out.extend((channels.len() as u16).to_le_bytes());
    out.extend(48000u32.to_le_bytes());
    out.extend((48000 * channels.len() as u32 * bytes as u32).to_le_bytes());
    out.extend((channels.len() as u16 * bytes).to_le_bytes());
    out.extend(bits.to_le_bytes());
    out.extend(b"data");
    out.extend(size.to_le_bytes());
    for frame in 0..channels[0].len() {
        for channel in channels {
            let value = (channel[frame] as f64).clamp(-1.0, 1.0);
            if bits == 32 {
                out.extend((value as f32).to_le_bytes());
            } else if bits == 16 {
                out.extend((kumi_common::js::number::round(value * 32767.0) as i16).to_le_bytes());
            } else {
                out.extend(&(kumi_common::js::number::round(value * 8388607.0) as i32).to_le_bytes()[..3]);
            }
        }
    }
    std::fs::write(path, out).unwrap();
}
fn aiff(path: &Path, channel: &[f32]) {
    let mut body = Vec::new();
    body.extend(b"AIFFCOMM");
    body.extend(18u32.to_be_bytes());
    body.extend(1u16.to_be_bytes());
    body.extend((channel.len() as u32).to_be_bytes());
    body.extend(16u16.to_be_bytes());
    body.extend(16398u16.to_be_bytes());
    body.extend(0xbb800000u32.to_be_bytes());
    body.extend(0u32.to_be_bytes());
    body.extend(b"SSND");
    body.extend((8 + channel.len() as u32 * 2).to_be_bytes());
    body.extend([0u8; 8]);
    for value in channel {
        body.extend((kumi_common::js::number::round(*value as f64 * 32767.0) as i16).to_be_bytes());
    }
    let mut out = Vec::new();
    out.extend(b"FORM");
    out.extend((body.len() as u32).to_be_bytes());
    out.extend(body);
    std::fs::write(path, out).unwrap();
}
#[tokio::test]
async fn wav_16_bit_24_bit_float_and_aiff_decode_to_the_same_samples_other_files_are_refused_plainly() {
    let folder = tempfile::tempdir().unwrap();
    let sine = tone(24000, 440.0, 0.5);
    for (name, bits) in [("d16.wav", 16), ("d24.wav", 24), ("dfloat.wav", 32), ("d16.aiff", 16)] {
        let path = folder.path().join(name);
        if name.ends_with("aiff") {
            aiff(&path, &sine);
        } else {
            wav(&path, &[sine.clone()], bits);
        }
        let mut source = open_audio(path, None).await.unwrap();
        assert_eq!(source.sample_rate, 48000.0, "{name}");
        assert_eq!(source.channels, 1, "{name}");
        assert_eq!(source.frames, sine.len(), "{name}");
        let block = source.read(1000).await.unwrap().unwrap();
        assert!((block[0][100] - sine[100]).abs() < 1e-3, "{name}");
        source.seek(23999.0);
        assert_eq!(source.read(1000).await.unwrap().unwrap()[0].len(), 1);
        assert!(source.read(1000).await.unwrap().is_none());
        source.close().await.unwrap();
    }
    std::fs::write(folder.path().join("notes.txt"), "hello").unwrap();
    assert!(open_audio(folder.path().join("notes.txt"), None).await.err().unwrap().0.contains("isn't an audio format"));
    std::fs::write(folder.path().join("fake.wav"), "not a wav file at all").unwrap();
    assert!(open_audio(folder.path().join("fake.wav"), None).await.err().unwrap().0.contains("doesn't look like WAV or AIFF"));
    assert!(open_audio(folder.path().join("missing.wav"), None).await.err().unwrap().0.contains("no file there"));
}
#[test]
fn osc_messages_go_out_and_come_back_as_maxs_udpsend_and_udpreceive_read_them() {
    let packet = encode_osc("/kumi/ears/arm", &[OscArg::Float(12.0), 47290.into(), "a token".into(), 0.5.into()]);
    assert_eq!(packet.len() % 4, 0);
    assert_eq!(
        decode_osc(&packet),
        Some(OscMessage {
            address: "/kumi/ears/arm".into(),
            args: vec![OscValue::Number(12.0), OscValue::Number(47290.0), OscValue::Text("a token".into()), OscValue::Number(0.5)]
        })
    );
    assert_eq!(
        decode_osc(&encode_osc(
            "/kumi/ears/hello",
            &[47324.into(), 9.into(), 1.into(), 48000.into(), "live_set tracks 3 devices 2".into()]
        ))
        .unwrap()
        .args,
        vec![
            OscValue::Number(47324.0),
            OscValue::Number(9.0),
            OscValue::Number(1.0),
            OscValue::Number(48000.0),
            OscValue::Text("live_set tracks 3 devices 2".into())
        ]
    );
    assert_eq!(decode_osc(&encode_osc("/x", &["".into()])).unwrap().args, vec![OscValue::Text("".into())]);
    assert!(decode_osc(b"not osc").is_none());
}
#[derive(Clone, Copy)]
struct Part {
    frames: usize,
    playing: Option<(f64, f64)>,
    audio: bool,
}
fn capture(parts: &[Part], interleaved: bool, big: bool, unrecorded: usize, invert: bool, lag: Option<usize>) -> Vec<u8> {
    let mut frames: Vec<Vec<f32>> = Vec::new();
    let mut beats = Vec::new();
    for part in parts {
        for frame in 0..part.frames {
            let value = if part.audio { (frame % 100) as f32 / 1000.0 } else { 0.0 };
            let beat = part.playing.map(|(from, per)| from + frame as f64 / per);
            beats.push(beat);
            frames.push(vec![value, if invert { -value } else { value }, beat.map_or(1.0, |v| (1.0 + v % 1.0) as f32)]);
        }
    }
    if let Some(lag) = lag {
        for (frame, channels) in frames.iter_mut().enumerate() {
            channels.push(beats[frame.saturating_sub(lag)].unwrap_or(0.0) as f32);
        }
    }
    let channels = if lag.is_some() { 4 } else { 3 };
    for _ in 0..unrecorded {
        frames.push(vec![0.0; channels]);
    }
    let mut bytes = vec![0u8; frames.len() * channels * 4];
    for (frame, values) in frames.iter().enumerate() {
        for (channel, value) in values.iter().enumerate() {
            let at = 4 * if interleaved { frame * channels + channel } else { channel * frames.len() + frame };
            bytes[at..at + 4].copy_from_slice(&if big { value.to_be_bytes() } else { value.to_le_bytes() });
        }
    }
    bytes
}
#[tokio::test]
async fn a_capture_is_read_in_whichever_layout_max_wrote_it_trimmed_and_placed_on_lives_beats_across_a_jump() {
    let beat = 480;
    let parts = [
        Part { frames: 1000, playing: None, audio: false },
        Part { frames: 600, playing: Some((251.3, beat as f64)), audio: false },
        Part { frames: beat * 8, playing: Some((30.0, beat as f64)), audio: true },
    ];
    for interleaved in [true, false] {
        for big in [false, true] {
            let read = parse_capture(&capture(&parts, interleaved, big, 5000, true, None), 3, 48000.0).unwrap();
            assert_eq!(read.left.len(), 1000 + 600 + beat * 8);
            assert!((read.left[1750] - 0.05).abs() < 1e-6 && (read.right[1750] + 0.05).abs() < 1e-6);
            let stretches = runs(&read, Anchors { first: Some(251.3), after_jump: Some(30.0) });
            assert_eq!(stretches.len(), 2);
            assert!((stretches[0].beat - 251.3).abs() < 1e-3 && (stretches[1].beat - 30.0).abs() < 1e-3);
            assert_eq!(stretches[1].samples_per_beat.round(), beat as f64);
            assert_eq!(frame_at(&stretches[1], 32.0), Some(1600 + beat * 2));
            assert_eq!(frame_at(&stretches[1], 40.0), None);
        }
    }
    let read = parse_capture(
        &capture(&[Part { frames: beat * 4, playing: Some((16.25, beat as f64)), audio: false }], true, false, 0, false, None),
        3,
        48000.0,
    )
    .unwrap();
    assert!((runs(&read, Anchors { first: Some(16.21), ..Default::default() })[0].beat - 16.25).abs() < 1e-3);
    let read = parse_capture(
        &capture(&[Part { frames: beat * 3, playing: Some((4.0, beat as f64)), audio: false }], true, false, 0, false, None),
        3,
        48000.0,
    )
    .unwrap();
    assert_eq!(runs(&read, Anchors { first: Some(4.0), ..Default::default() }).len(), 1);
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("part.wav");
    let whole = parse_capture(&capture(&parts, true, false, 0, false, None), 3, 48000.0).unwrap();
    write_capture_wav(&file, &whole, 1600.0, (1600 + beat * 2) as f64).await.unwrap();
    let mut source = open_audio(file, None).await.unwrap();
    assert_eq!(source.sample_rate, 48000.0);
    assert_eq!(source.channels, 2);
    assert_eq!(source.frames, beat * 2);
    source.close().await.unwrap();
    let raw = dir.path().join("capture.raw");
    std::fs::write(&raw, capture(&parts, true, false, 0, false, None)).unwrap();
    assert_eq!(read_capture(&raw, 3, 48000.0).await.unwrap().left.len(), 1000 + 600 + beat * 8);
}
#[test]
fn lives_jump_that_lands_on_a_beat_is_found_by_the_position_the_device_records() {
    let beat = 24000;
    let lag = 480;
    let parts = [
        Part { frames: 1000, playing: None, audio: false },
        Part { frames: beat / 2, playing: Some((251.5, beat as f64)), audio: false },
        Part { frames: beat * 8, playing: Some((30.0, beat as f64)), audio: true },
    ];
    assert_eq!(
        runs(
            &parse_capture(&capture(&parts, true, false, 0, false, None), 3, 48000.0).unwrap(),
            Anchors { first: Some(251.5), ..Default::default() }
        )
        .len(),
        1
    );
    for (interleaved, big) in [(true, true), (false, false)] {
        let read = parse_capture(&capture(&parts, interleaved, big, 2000, false, Some(lag)), 4, 48000.0).unwrap();
        assert_eq!(read.left.len(), 1000 + beat / 2 + beat * 8);
        let stretches = runs(&read, Anchors::default());
        assert_eq!(stretches.len(), 2);
        assert_eq!(stretches[1].from, 1000 + beat / 2);
        assert!((stretches[0].beat - 251.5).abs() < 1e-3 && (stretches[1].beat - 30.0).abs() < 1e-3);
        assert_eq!(frame_at(&stretches[1], 32.0), Some(1000 + beat / 2 + beat * 2));
    }
    let landing = [
        Part { frames: 1000, playing: None, audio: false },
        Part { frames: 7000, playing: Some((14.95, beat as f64)), audio: false },
        Part { frames: 64, playing: None, audio: false },
        Part { frames: beat * 6, playing: Some((64.0 / beat as f64, beat as f64)), audio: false },
    ];
    let read = parse_capture(&capture(&landing, true, false, 0, false, Some(lag)), 4, 48000.0).unwrap();
    let stretches = runs(&read, Anchors::default());
    let landed = stretches.last().unwrap();
    assert_eq!(landed.from, 8064);
    assert_eq!(frame_at(landed, 0.0), Some(8000));
    let shown = [
        Part { frames: 500, playing: None, audio: false },
        Part { frames: 7000, playing: Some((12.3, beat as f64)), audio: false },
        Part { frames: beat * 6, playing: Some((40.75, beat as f64)), audio: false },
    ];
    let read = parse_capture(&capture(&shown, true, false, 0, false, Some(lag)), 4, 48000.0).unwrap();
    assert_eq!(
        runs(&read, Anchors::default()).iter().map(|r| (r.from, (r.beat * 1000.0).round() / 1000.0)).collect::<Vec<_>>(),
        vec![(500, 12.3), (7500, 40.75)]
    );
}
#[test]
fn kumi_fetches_the_build_each_computer_has() {
    for (platform, arch, asset) in [
        ("darwin", "arm64", Some("yt-dlp_macos.zip")),
        ("win32", "x64", Some("yt-dlp_win.zip")),
        ("win32", "arm64", Some("yt-dlp_win_arm64.zip")),
        ("linux", "x64", Some("yt-dlp_linux")),
        ("freebsd", "x64", None),
    ] {
        assert_eq!(yt_dlp_asset(platform, arch), asset);
    }
    assert_eq!(whisper_asset("win32", "x64"), Some("whisper-bin-x64.zip"));
    assert_eq!(whisper_asset("linux", "arm64"), Some("whisper-bin-ubuntu-arm64.tar.gz"));
    assert_eq!(whisper_asset("darwin", "arm64"), None);
}
#[test]
fn ffmpegs_build_for_this_computer_is_the_newest_numbered_lgpl_one() {
    let names = [
        "ffmpeg-master-latest-win64-lgpl.zip",
        "ffmpeg-n8.1-latest-win64-lgpl-8.1.zip",
        "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip",
        "ffmpeg-n9.0-latest-win64-gpl-9.0.zip",
        "ffmpeg-n9.0-latest-winarm64-lgpl-9.0.zip",
        "ffmpeg-n10.0-latest-linux64-lgpl-10.0.tar.xz",
        "ffmpeg-n9.0-latest-linuxarm64-lgpl-9.0.tar.xz",
        "ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip",
    ]
    .map(str::to_string);
    for (platform, arch, expected) in [
        ("win32", "x64", Some(names[2].clone())),
        ("win32", "arm64", Some(names[4].clone())),
        ("linux", "x64", Some(names[5].clone())),
        ("linux", "arm64", Some(names[6].clone())),
        ("darwin", "arm64", None),
        ("win32", "ia32", None),
    ] {
        assert_eq!(ffmpeg_asset(&names, platform, arch), expected);
    }
}
fn model_download(oid: String) -> Download {
    Arc::new(move |url, _| {
        let oid = oid.clone();
        async move {
            Ok(if url.contains("/api/models/") {
                serde_json::to_vec(&serde_json::json!([{ "path":"ggml-tiny.en.bin","size":14,"lfs":{"oid":oid}}])).unwrap()
            } else {
                b"a speech model".to_vec()
            })
        }
        .boxed()
    })
}
#[tokio::test]
async fn a_download_that_doesnt_match_its_published_checksum_isnt_kept() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("tools-mismatch");
    let asset = yt_dlp_asset(kumi_runtime::system::platform(), node_arch()).unwrap();
    let options = ProgramOptions {
        tools_dir: dir.to_string_lossy().into_owned(),
        env: Some(HashMap::from([("PATH".into(), "".into())])),
        download: Some(Arc::new(move |url, _| {
            async move {
                Ok(if url.ends_with("SHA2-256SUMS") {
                    format!("{}  {asset}\n", "0".repeat(64)).into_bytes()
                } else {
                    b"not yt-dlp".to_vec()
                })
            }
            .boxed()
        })),
        ..Default::default()
    };
    assert!(find_yt_dlp(&options).await.unwrap_err().to_string().contains("didn't match"));
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    let mut options = ProgramOptions {
        env: Some(HashMap::new()),
        download: Some(model_download("f".repeat(64))),
        free: Some(Arc::new(|_| async { Some(1e12) }.boxed())),
        ..options
    };
    assert!(whisper_model("ggml-tiny.en.bin", &options).await.unwrap_err().to_string().contains("didn't match"));
    assert_eq!(std::fs::read_dir(dir.join("whisper-models")).unwrap().count(), 0);
    options.download = Some(model_download(hex::encode(Sha256::digest(b"a speech model"))));
    let fetched = Arc::new(Mutex::new(Vec::new()));
    let said = fetched.clone();
    options.on_fetch = Some(Arc::new(move |s| said.lock().unwrap().push(s.to_string())));
    let path = whisper_model("ggml-tiny.en.bin", &options).await.unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "a speech model");
    assert_eq!(fetched.lock().unwrap().len(), 1);
    options.download = Some(Arc::new(|_, _| async { Err(VideoFailure::other("fetched again")) }.boxed()));
    assert_eq!(whisper_model("ggml-tiny.en.bin", &options).await.unwrap(), path);
    assert!(whisper_model("../escape.bin", &options).await.unwrap_err().to_string().contains("isn't a whisper.cpp model"));
    options.env = Some(HashMap::from([("KUMI_YTDLP".into(), root.path().join("nowhere").to_string_lossy().into_owned())]));
    assert!(find_yt_dlp(&options).await.unwrap_err().to_string().contains("isn't there"));
}
#[test]
fn kumi_goes_only_to_public_addresses() {
    use kumi_runtime::web::net::{checked_url, private_address};
    for inside in [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "198.18.0.1",
        "::1",
        "::",
        "fe80::1",
        "fe80::1%en0",
        "fc00::1",
        "fd12:3456::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "64:ff9b::7f00:1",
        "64:ff9b::10.0.0.1",
        "2002::1",
        "not an address",
    ] {
        assert!(private_address(inside), "{inside}");
    }
    for outside in ["8.8.8.8", "1.1.1.1", "140.82.112.3", "172.32.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"] {
        assert!(!private_address(outside), "{outside}");
    }
    for bad in [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "http://user:secret@example.com/",
        "http://localhost:8080/",
        "http://api.localhost/",
        "http://printer.local/",
        "http://intranet/",
        "http://nas.lan/",
        "http://0x7f.1/",
        "http://2130706433/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://169.254.169.254/latest/meta-data/",
        "not a url",
    ] {
        assert!(checked_url(bad, None).is_err(), "{bad}");
    }
    assert_eq!(checked_url("https://example.com/a b", None).unwrap().as_str(), "https://example.com/a%20b");
    assert_eq!(checked_url("http://8.8.8.8/", None).unwrap().host_str(), Some("8.8.8.8"));
}
#[tokio::test]
async fn wavetables_shapes_as_harmonics_keyframes_morphing_cycles_cut_from_a_sound_and_serums_frame_marker() {
    use kumi_runtime::audio::wavetable::*;
    assert_eq!(
        shape_harmonics(Shape::Square, Some(0.5), Some(5)).iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>(),
        vec![1.0, 0.0, 0.333, 0.0, 0.2]
    );
    assert!(shape_harmonics(Shape::Triangle, Some(0.5), Some(3))[2] < 0.0);
    let sine = synthesize(&[1.0]);
    assert_eq!(sine.len(), FRAME);
    assert!((sine[FRAME / 4] - 1.0).abs() < 1e-6);
    let frames = frames_from_keyframes(
        &[Keyframe { shape: Some(Shape::Sine), ..Default::default() }, Keyframe { shape: Some(Shape::Saw), ..Default::default() }],
        Some(16.0),
    )
    .unwrap();
    assert_eq!(frames.len(), 16);
    assert!(frames.iter().flatten().all(|v| v.abs() <= 0.99 + 1e-6));
    let folder = tempfile::tempdir().unwrap();
    let file = folder.path().join("Kumi Sweep.wav");
    write_wavetable(&file, &frames).await.unwrap();
    let bytes = std::fs::read(&file).unwrap();
    assert!(bytes.windows(4).any(|v| v == b"clm "));
    assert!(bytes.windows(7).any(|v| v == b"<!>2048"));
    let mut source = open_audio(&file, None).await.unwrap();
    assert_eq!(source.frames, 16 * FRAME);
    assert_eq!(source.channels, 1);
    source.close().await.unwrap();
    let saw: Vec<f32> = (0..96000)
        .map(|i| {
            ((1..40).map(|k| (2.0 * std::f64::consts::PI * k as f64 * 110.0 * i as f64 / 48000.0).sin() / k as f64).sum::<f64>() * 0.3)
                as f32
        })
        .collect();
    let note = folder.path().join("wavetable-saw.wav");
    wav(&note, &[saw.clone()], 32);
    assert!((period_of(&saw[..48000], 48000.0).unwrap() - 48000.0 / 110.0).abs() < 1.0);
    let cut = frames_from_audio(note.to_str().unwrap(), 8.0, None, None).await.unwrap();
    assert_eq!(cut.len(), 8);
    assert!(cut.iter().all(|f| f.len() == FRAME));
}
#[tokio::test]
async fn off_a_mac_ffmpeg_is_fetched_once_checked_against_its_release_checksum_and_only_the_program_kept() {
    let root = tempfile::tempdir().unwrap();
    let build = root.path().join("build/ffmpeg-n9.0-latest-linux64-lgpl-9.0");
    std::fs::create_dir_all(build.join("bin")).unwrap();
    std::fs::write(build.join("bin/ffmpeg"), "#!/bin/sh\necho ffmpeg version fixture\n").unwrap();
    std::fs::write(build.join("bin/ffprobe"), "x").unwrap();
    std::fs::write(build.join("LICENSE.txt"), "LGPL").unwrap();
    let archive = root.path().join("build.tar.gz");
    assert!(std::process::Command::new(kumi_runtime::system::system_program_default(kumi_runtime::system::SystemProgram::Tar))
        .args(["-czf", archive.to_str().unwrap(), "-C", root.path().join("build").to_str().unwrap(), "ffmpeg-n9.0-latest-linux64-lgpl-9.0"])
        .status()
        .unwrap()
        .success());
    let data = std::fs::read(archive).unwrap();
    let sha = format!("sha256:{}", hex::encode(Sha256::digest(&data)));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let said = Arc::new(Mutex::new(Vec::new()));
    fn downloader(data: Vec<u8>, digest: String, asked: Arc<Mutex<Vec<String>>>) -> Download {
        Arc::new(move |url, _| {
            let data = data.clone();
            let digest = digest.clone();
            asked.lock().unwrap().push(url.clone());
            async move{Ok(if url.starts_with("https://api.github.com/"){serde_json::to_vec(&serde_json::json!({"assets":[{"name":"ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz","size":141_000_000,"digest":digest,"browser_download_url":"https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz"}]})).unwrap()}else{data})}.boxed()
        })
    }
    let told = said.clone();
    let tools = root.path().join("tools");
    let mut options = FfmpegOptions {
        env: Some(HashMap::new()),
        tools_dir: Some(tools.to_string_lossy().into_owned()),
        platform: Some("linux".into()),
        arch: Some("x64".into()),
        download: Some(downloader(data.clone(), sha, asked.clone())),
        on_fetch: Some(Arc::new(move |s| told.lock().unwrap().push(s.to_string()))),
        free: Some(Arc::new(|_| async { Some(1e12) }.boxed())),
        installed_only: true,
        ..Default::default()
    };
    assert!(find_ffmpeg(options.clone()).await.unwrap().is_none());
    assert!(asked.lock().unwrap().is_empty());
    options.installed_only = false;
    let found = find_ffmpeg(options.clone()).await.unwrap().unwrap();
    assert_eq!(found, tools.join("ffmpeg/ffmpeg").to_string_lossy());
    assert_eq!(std::fs::read_dir(tools.join("ffmpeg")).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&found).unwrap().permissions().mode() & 0o111, 0o111);
    }
    assert_eq!(*said.lock().unwrap(), vec!["Kumi is fetching ffmpeg, which it reads audio formats and videos with (once, about 141 MB)."]);
    assert_eq!(asked.lock().unwrap().len(), 2);
    assert_eq!(find_ffmpeg(options.clone()).await.unwrap().unwrap(), found);
    assert_eq!(asked.lock().unwrap().len(), 2);
    let other = root.path().join("other");
    let mut bad = options.clone();
    bad.tools_dir = Some(other.to_string_lossy().into_owned());
    bad.download = Some(downloader(data, format!("sha256:{}", "0".repeat(64)), Arc::new(Mutex::new(Vec::new()))));
    assert!(find_ffmpeg(bad).await.unwrap_err().to_string().contains("didn't match its release's checksum"));
    assert!(!other.join("ffmpeg").exists());
    assert_eq!(std::fs::read_dir(other).unwrap().count(), 0);
    let before = asked.lock().unwrap().len();
    options.tools_dir = Some(root.path().join("third").to_string_lossy().into_owned());
    options.free = Some(Arc::new(|_| async { Some(150_000_000.0) }.boxed()));
    assert!(find_ffmpeg(options)
        .await
        .unwrap_err()
        .to_string()
        .contains("Kumi needs ffmpeg for this, and would fetch it. Only 150 MB is free on the disk Kumi keeps its programs on"));
    assert_eq!(asked.lock().unwrap().len(), before + 1);
}
