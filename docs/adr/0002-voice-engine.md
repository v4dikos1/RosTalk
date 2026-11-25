# ADR 0002. Голосовой движок: livekit + cpal + AudioProcessingModule

- **Статус:** принято (этап 0.2); сборка под Windows не проверена локально
- **Дата:** 2026-11-19
- **Проверял:** spike `spikes/voice-loop`

## Контекст

Дизайн (раздел 5.2) требует нативный голосовой тракт в Rust:

```text
cpal 48 кГц / 10 мс → ресемплинг → APM (AEC3, NS, AGC, HPF)
  → гейт → NativeAudioSource → Opus (DTX, RED, FEC)
входящие дорожки → громкость/mute → микшер → опорный сигнал AEC → cpal
```

Надо было выяснить, что из этого реально даёт SDK `livekit` 0.12.0 на
libwebrtc, какие у APM требования, сколько это стоит по CPU/памяти и какая
задержка получается на практике.

## Что сделано

`spikes/voice-loop` — консольный клиент:

- захват: `cpal` (устройство) **или** WAV-файл 48 кГц моно, **или**
  синтетический источник со щелчком раз в секунду;
- обработка: `livekit::webrtc::native::apm::AudioProcessingModule`
  (AEC3 + AGC2 + NS + HPF, каждая ступень отключается флагом), кадры строго
  10 мс / 480 сэмплов;
- публикация: `NativeAudioSource` → `LocalAudioTrack` с `TrackPublishOptions`
  (битрейт, DTX, RED, источник `microphone`);
- приём: `NativeAudioStream` на каждую дорожку, громкость 0–200 % и mute на
  пользователя, микшер, вывод в WAV или `cpal`;
- обратный поток APM — это микшированный выход (опорный сигнал для эха);
- измерение задержки: `--click-source` печатает `CLICK_EMIT <epoch ms>`,
  `--click-detect` печатает `CLICK_RECV <epoch ms>`, `--analyze` считает
  статистику.

Сборка: Docker `rust:1.97-bookworm` + clang 21 (libwebrtc собран hermetic
libc++ и требует clang ≥ 21; clang 14 из Debian не подходит), финальный образ
`debian:bookworm-slim`.

## Результаты

### Сквозной тракт

Два контейнера на одной Docker-сети против встроенного LiveKit (ADR 0001):
издатель со щелчками и приёмник, пишущий WAV. Оба подключились, щелчки дошли,
WAV записан (1.9 МБ за 20 с).

| Показатель | Значение |
|---|---|
| Задержка «щелчок в источнике → кадр на выходе» | **median 75 мс**, min 56, p95 95, max 95 (n = 12) |
| Что входит в цифру | квантование 10 мс, кадр 10 мс, APM, Opus, сеть loopback, джиттер-буфер `NativeAudioStream`, микшер, детектор по 10 мс кадрам |

Это укладывается в цель 60–120 мс из дизайна. Цифра получена в контейнерах на
одной машине; реальная сеть и Windows-аудио добавят задержку.

### Ресурсы

Методика: Rust-клиент в отдельном контейнере, 45 с, входящие дорожки — PCMU от
Go-проб из spike 0.1; CPU — cgroup `usage_usec`, память — `memory.current`,
сверено с `docker stats`.

| Входящих дорожек | CPU (одно ядро) | Память |
|---|---|---|
| 1 | **4.0 %** | **9.2 МБ** |
| 8 | **8.7–9.3 %** | **9.1–11.7 МБ** |

Бинарник (Linux, strip, со статическим libwebrtc): **30.5 МБ**.

Оговорки: Docker Desktop искажает абсолютные цифры; клиент не декодирует
видео и не рисует UI. Бюджеты клиента из раздела 6 (экономный режим < 80 МБ,
окно < 250 МБ) проверяются на этапе 7.1 вместе с WebView.

### Что реально настраивается в Opus через SDK

| Параметр | Как задаётся | Ограничения |
|---|---|---|
| Битрейт | `TrackPublishOptions.audio_encoding = Some(AudioEncoding { max_bitrate })` | только верхняя граница; фактический битрейт решает WebRTC |
| DTX | `TrackPublishOptions.dtx` | работает |
| RED | `TrackPublishOptions.red` | работает, но RED — отдельный кодек в SDP; сервер должен его разрешать |
| Источник | `TrackPublishOptions.source` | `Microphone`, `ScreenShareAudio` и т. д. |
| Стерео | `NativeAudioSource::new(..., channels = 2)` | отдельного флага Opus нет; в single-PC режиме SDK патчит SDP (`stereo=1`). Проверять на реальном тракте |
| FEC | **не настраивается** | inband FEC/NACK — внутренняя политика libwebrtc; API нет |
| Длина кадра | **10 мс** на входе `NativeAudioSource` | APM требует 10 мс; 20/40/60 мс кадры Opus SDK сам собирает из 10 мс |
| Частота | 48 кГц (можно 8/16/32) | APM поддерживает эти частоты; для голоса фиксируем 48 кГц |

### Требования APM

- Кадр строго **10 мс** на канал; для 48 кГц это 480 сэмплов.
- AEC3 работает только при подаче **reverse stream** (то, что играет в
  наушники/колонки) в том же темпе; задержку между потоками задаёт
  `set_stream_delay_ms` (в spike — 50 мс).
- Доступные ступени: `echo_canceller`, `gain_controller2` (+ adaptive digital),
  `high_pass_filter`, `noise_suppression`. Отдельного « RNNoise» в SDK нет.
- APM не ресемплирует: при частоте устройства ≠ 48 кГц нужен ресемплер **до**
  APM. В spike файловый режим требует 48 кГц; в клиенте этапа 2.3 нужен
  `rubato`/свой ресемплер.

### Ограничения и шум в логах

- libwebrtc пишет в stderr предупреждения `Candidate has an unknown component`,
  `Inconsistent congestion control feedback types`, `Stream already exists with
  ssrc`, `Discarding candidate because port is already done gathering`. Звук
  при этом идёт; в клиенте эти логи надо приглушать и не считать ошибкой.
- `cpal` 0.18 изменил API: `Device::name()` → `Device::description()?.name()`,
  `StreamConfig` передаётся по значению, `SampleRate` — алиас `u32`. Версию
  надо пиновать, примеры 0.15 не компилируются.
- `NativeAudioStream` уже содержит джиттер-буфер NetEQ; свой буфер сверху
  добавлять не нужно.
- `AudioProcessingModule` не `Clone`; в spike он под `tokio::sync::Mutex`, что
  для реального времени не идеально. В этапе 2.3 обработку надо вынести в
  отдельный аудиопоток с кольцевыми буферами, без мьютекса в колбэках.

### Сборка под Windows

**Локально не проверена:** на машине нет MSVC Build Tools, а `libwebrtc`
для Windows собирается MSVC-тулчейном. В CI нужен job `windows-latest`:

```yaml
- uses: dtolnay/rust-toolchain@stable
- run: cargo build --release
  working-directory: client/src-tauri
```

До первого зелёного Windows-джоба этап 2.3 нельзя считать закрытым: неизвестны
поведение WASAPI, выбор устройств и AEC с реальными драйверами.

## Решение

Берём **`livekit` 0.12.0 + `cpal` 0.18.2 + `AudioProcessingModule`**.
Альтернатив с сопоставимым контролем над обработкой и PTT нет; запасной
вариант — только если Windows-сборка или WASAPI окажутся проблемой.

Обязательные условия для этапа 2.3:

- аудио-колбэки без блокировок и аллокаций, обмен через `ringbuf`;
- ресемплер до APM для устройств, не поддерживающих 48 кГц;
- APM и публикация — в отдельном потоке, не в `tokio`-задаче с мьютексом;
- гейт (PTT/VAD) после APM, до `capture_frame`;
- проверка на Windows с реальной гарнитурой и колонками — обязательный
  чек-лист PR.

## Точные версии

| Компонент | Версия |
|---|---|
| Rust | 1.97.1 (toolchain rust-sdks) |
| `livekit` | 0.12.0 (`libwebrtc` 0.4.2, `webrtc-sys` 0.3.55) |
| `livekit-api` | 0.11.0 |
| `cpal` | 0.18.2 |
| `tokio` | 1.x |
| clang (Linux build) | 21 |
| Go-сервер для теста | spike 0.1 (LiveKit Server 1.13.11) |

## Как воспроизвести

```powershell
cd spikes/voice-loop
docker build -t rostalk-voice-loop-spike .
# сервер: spikes/embed-livekit, bench/compose.yaml (node_ip=172.28.0.10)

# издатель
docker run --rm --network bench_bench -v "${PWD}/out:/out" `
  --entrypoint sh rostalk-voice-loop-spike -c `
  "cat /etc/ssl/certs/ca-certificates.crt /spike-data/ca.pem > /tmp/ca.crt; `
   SSL_CERT_FILE=/tmp/ca.crt voice-loop --url wss://172.28.0.10:7443 `
   --api-key <key> --api-secret <secret> --room voice --identity pub `
   --click-source --duration 12"

# приёмник (запустить на 5 секунд раньше)
docker run --rm --network bench_bench -v "${PWD}/out:/out" `
  --entrypoint sh rostalk-voice-loop-spike -c `
  "cat /etc/ssl/certs/ca-certificates.crt /spike-data/ca.pem > /tmp/ca.crt; `
   SSL_CERT_FILE=/tmp/ca.crt voice-loop --url wss://172.28.0.10:7443 `
   --api-key <key> --api-secret <secret> --room voice --identity recv `
   --no-publish --output-file /out/recv.wav --click-detect --duration 20"

# анализ
docker run --rm -v "${PWD}/out:/out" --entrypoint voice-loop rostalk-voice-loop-spike `
  --analyze /out/emit.log /out/recv.log
```

Сертификат сервера — `ca.pem` из тома `bench_bench-data`; клиент доверяет ему
через `SSL_CERT_FILE`.
