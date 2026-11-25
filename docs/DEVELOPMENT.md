# Разработка RosTalk

Как собрать и запустить сервер и клиент из исходников, прогнать тесты и
проверки. Правила разработки — в [`CONTRIBUTING.md`](../CONTRIBUTING.md),
выпуск релиза — в [`RELEASE.md`](RELEASE.md), установка для пользователей —
в [`INSTALL.md`](INSTALL.md).

## Структура

```text
proto/rostalk/v1/         контракт протокола (.proto), источник истины
proto/gen/go/             сгенерированный Go-код (отдельный Go-модуль)
server/                   Go-модуль сервера (Linux), cmd/rostalk-server
client/src-tauri/         Rust-оболочка Tauri 2 + crates/{core,voice,platform,hosting}
client/src-tauri/apps/    установщик сервера для Windows (rostalk-server-setup)
client/ui/                React + TypeScript + Vite, интерфейс и привязки proto
tools/rostalkctl/         отдельный Go-модуль консольного клиента и тестовых ботов
tools/anticheat/          проверки античит-гигиены
deploy/                   install.sh, Docker, скрипты релиза
docs/                     дизайн, ADR, установка, выпуск
```

`server/`, `tools/rostalkctl` и `proto/gen/go` — **три отдельных Go-модуля**.
`livekit-server` и `server-sdk-go` тянут несовместимые версии форков Pion, в
одном `go.mod` они не собираются (ADR 0001). Сгенерированный Go вынесен в свой
модуль, потому что его используют и сервер, и `rostalkctl`.

## Требования

| Инструмент | Версия | Зачем |
|---|---|---|
| Go | 1.27 (см. `server/go.mod`) | сервер, `rostalkctl`, генерация |
| buf | 1.75 | proto: линт, breaking, генерация |
| golangci-lint | 2.15 | Go-линтеры и форматирование |
| Node.js | 24 LTS | UI, Vite, Vitest, Tauri CLI (vitest 5 поддерживает ^22.12, ^24 и >=26; Node 25 — нет) |
| Rust stable | MSVC-тулчейн | клиент Windows |
| MSVC Build Tools 2022 + WebView2 | — | сборка Tauri на Windows |
| Docker Desktop | — | сервер на Windows, тесты, dev-образ |
| GNU make | — | команды ниже |

Версии зафиксированы: Go — директивой `go` в `server/go.mod`,
protoc-плагины и их версии — в `Makefile` и `client/ui/package.json`,
зависимости UI — `package-lock.json`, Rust — `Cargo.lock`.

## Быстрый старт (Linux)

```sh
make setup          # npm ci, go mod download и protoc-плагины
make gen            # сгенерировать привязки протокола (уже в репозитории)
make check          # линтеры, тесты, сверка сгенерированного кода
make dev-server     # сервер из исходников на :7443
make dev-client     # окно клиента + Vite dev server
```

`make dev-server` собирает сервер только под Linux: под Windows используй
`make dev-server-docker` (см. ниже). Клиентская оболочка собирается на Windows
(MSVC + WebView2); Linux-сборка Tauri не проверяется.

## Быстрый старт (Windows)

Сервер под Windows нативно не собирается никогда: только в Docker Desktop.
Клиент собирается нативно MSVC-тулчейном.

### 1. Узнай LAN IP хоста

Именно этот адрес клиенты (и клиент на том же ПК) используют для медиа.
`localhost`/`127.0.0.1` **не работает**: ICE-сокет клиента привязан к LAN-адресу
(ADR 0001).

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object InterfaceAlias, IPAddress
```

Бери адаптер физической сети (Wi-Fi/Ethernet), например `192.168.1.10`.
Адаптеры `vEthernet (WSL)`, `vEthernet (Default Switch)` и адреса `172.x` — это
виртуальные сети Docker Desktop: другие машины в LAN до них не достучатся.
В `cmd.exe` то же самое показывает `ipconfig` (IPv4 Address активного адаптера).

### 2. Запусти dev-сервер

```powershell
Copy-Item deploy/dev/.env.example deploy/dev/.env
notepad deploy/dev/.env      # ROSTALK_ADVERTISE_IP=<твой LAN IP>
make dev-server-docker
```

Без make — та же команда, WSL и установленный Go не нужны:

```powershell
docker compose -f deploy/dev/compose.yaml up --build
```

Compose сам читает `deploy/dev/.env` и передаёт:

| Переменная | Флаг сервера | Значение |
|---|---|---|
| `ROSTALK_ADVERTISE_IP` | `--advertise-ip` и `--public-host` | LAN IP хоста, не `127.0.0.1` |
| `ROSTALK_LOOPBACK` | `--enable-loopback-candidate` | `false` (с не-loopback IP иначе ломается UDP, ADR 0001) |

Данные (база, ключи, сертификаты) живут в томе `rostalk-dev_rostalk-data`.
При первом запуске сервер печатает в stdout одноразовую админ-ссылку
`rostalk://join?host=<LAN IP>:7443&fp=...&invite=...`:

```powershell
docker compose -f deploy/dev/compose.yaml logs server |
  Select-String "rostalk://join"
```

Ссылка печатается в stdout, а не в лог: в журнале (`slog`) токенов, ключей и
паролей нет. Тот, кто зайдёт по ссылке первым, станет администратором.
Отпечаток `fp` — SHA-256 TLS-листа, `server_id` подписи — SHA-256 отдельного
Ed25519-ключа (ADR 0004).

Тесты сервера на Windows — в Linux-контейнере, с race detector, без локального Go:

```powershell
make test-server-docker
# или
docker compose -f deploy/dev/compose.yaml --profile test run --rm --build test
```

`go test -race` требует cgo, а сервер собирается с `CGO_ENABLED=0`; поэтому
локальный `make check` на Windows гоняет тесты без `-race`, а Linux и
контейнер — с ним.

### 3. Первый запуск и вход

Сервер настраивается только флагами и переменными окружения; всё остальное
(имя, режим входа, лимиты) лежит в таблице `settings`.

| Флаг | Переменная | По умолчанию | Назначение |
|---|---|---|---|
| `--data` | `ROSTALK_DATA` | `./data` | база, ключи, сертификаты, админ-инвайт |
| `--listen` | `ROSTALK_LISTEN` | `:7443` | HTTPS/WSS |
| `--public-host` | `ROSTALK_PUBLIC_HOST` | LAN IP или `--advertise-ip` | хост в ссылке; в dev — LAN IP |
| `--domain` | `ROSTALK_DOMAIN` | — | режим домена: сертификат Let's Encrypt, ссылки без `fp` (ADR 0017) |
| `--advertise-ip` | `ROSTALK_ADVERTISE_IP` | LAN IP хоста | адрес в ICE-кандидатах (`rtc.node_ip`) и fallback для `--public-host` |
| `--enable-loopback-candidate` | `ROSTALK_LOOPBACK` | `false` | ICE-loopback; в LAN держать `false` (ADR 0001) |
| `--login-mode` | `ROSTALK_LOGIN_MODE` | из `settings` | режим входа: `invite`, `password` или `open` (ADR 0008) |
| `--server-password` | `ROSTALK_SERVER_PASSWORD` | — | пароль для `--login-mode=password`; хешируется argon2id, в лог не попадает |
| `--media-signal-port` | `ROSTALK_MEDIA_SIGNAL_PORT` | `7880` | loopback-сигналинг LiveKit, наружу не публикуется |
| `--media-udp-port` | `ROSTALK_MEDIA_UDP_PORT` | `7882` | UDP-медиа |
| `--media-tcp-port` | `ROSTALK_MEDIA_TCP_PORT` | `7881` | ICE-TCP fallback |
| `--metrics-addr` | `ROSTALK_METRICS_ADDR` | `127.0.0.1:9090` | локальный Prometheus (`/metrics`); `off` выключает, наружу не публикуется |
| `--log-file` | `ROSTALK_LOG_FILE` | `<data>/logs/rostalk-server.log` в установщике | файл логов с ротацией по размеру (пусто — только journal) |
| `--log-max-size` | `ROSTALK_LOG_MAX_SIZE` | `10485760` | порог ротации в байтах |
| `--log-keep` | `ROSTALK_LOG_KEEP` | `5` | сколько ротированных файлов хранить |

Метрики слушают только loopback: `curl http://127.0.0.1:9090/metrics` на самом
сервере. Там коллекторы LiveKit (`livekit_*`), стандартные `process_*`/`go_*` и
RosTalk: `rostalk_online_users`, `rostalk_channels`, `rostalk_media_rooms`,
`rostalk_media_participants`, `rostalk_media_tracks`, `rostalk_build_info`. Порт
`9090` не открывается файрволом и не входит в список портов мастера установки.

Лог-файл ротируется перед строкой, которая пересекла бы лимит: текущая строка
не теряется, старые файлы получают суффиксы `.1`…`.<keep>`. systemd по-прежнему
пишет ту же строку в journal, поэтому `journalctl -u rostalk-server` работает.

Порты медиа нужны прежде всего тестам: они поднимают настоящий сервер на
случайных портах. В dev-окружении оставляй значения по умолчанию — они
опубликованы в `deploy/dev/compose.yaml`. Второй пользователь (для второго бота
или коллеги) добавляется командой `rostalk-server invite`: она открывает каталог
данных работающего сервера и печатает ссылку с тем же хостом и отпечатком:

```powershell
docker compose -f deploy/dev/compose.yaml exec server `
  rostalk-server invite --data=/data --listen=:7443 --public-host=192.168.1.10
```

```powershell
# сервер (в Linux-контейнере на Windows): см. выше, ссылка в stdout
# клиент:
cd tools/rostalkctl
go run . identity new --out "$env:TEMP\rostalk-identity.key"
go run . connect "rostalk://join?host=192.168.1.10:7443&fp=...&invite=..." `
  --identity "$env:TEMP\rostalk-identity.key" --nick alice --once
```

`--once` печатает снимок `Welcome` и выходит; без него `rostalkctl` ждёт события
до Ctrl+C. `--ca data/ca.crt` дополнительно проверяет всю TLS-цепочку вместо
одного пиннинга отпечатка. Тот же клиент используется интеграционными тестами
(`tools/rostalkctl`), включая end-to-end проверку «пустой каталог → ссылка →
Welcome».

Каналы и присутствие: на первом запуске сервер создаёт «Лобби» и
«AFK», а `rostalkctl` умеет показать дерево, войти в канал и следить за событиями:

```powershell
cd tools/rostalkctl
go run . channels "rostalk://join?host=192.168.1.10:7443&fp=...&invite=..." --nick alice
go run . join "rostalk://join?..." --nick alice "Лобби"        # имя или #id
go run . watch "rostalk://join?..." --nick bob                 # второй терминал
```

`watch` печатает события (`user moved Лобби -> AFK`, изменения каналов), поэтому
два открытых `watch` видят перемещения друг друга. `join` принимает
`--channel-password` (или `ROSTALK_CHANNEL_PASSWORD`) для защищённых каналов.
Пароли каналов, лимиты участников, временные каналы и перемещения по дереву
проверяются сервером.

### Медиа и боты

Вход в голосовой канал возвращает `MediaCredentials`: адрес шлюза
(`wss://<host>:7443/rtc`), комнату (`channel-<id>`), токен на 60 секунд и
идентификатор участника (`<user_id>:voice`; стрим — `<user_id>:stream`). Токен
подписывается ключом, который сервер генерирует при первом запуске и хранит в
таблице `settings`; в лог он не попадает. Комната живёт в памяти: после
перезапуска она создаётся заново при следующем входе.

`rostalkctl bot` — headless-участник для проверки звука. Он входит в канал через
control plane, публикует в комнату G.711 mu-law (тон или WAV-файл) и печатает
счётчики:

```powershell
cd tools/rostalkctl
go build -o "$env:TEMP\rostalkctl.exe" .
& "$env:TEMP\rostalkctl.exe" bot "rostalk://join?host=192.168.1.10:7443&fp=...&invite=..." `
  --nick alice --channel "Лобби" --tone
& "$env:TEMP\rostalkctl.exe" bot "<ссылка второго пользователя>" `
  --nick bob --channel "Лобби" --play "$env:TEMP\tone.wav"
```

Каждый бот печатает `bot: sent=N frames, remote=1, received: 2:voice=… packets`:
счётчики должны расти у обоих. `--duration 20s` завершает бота сам (он выходит из
канала и отключается), `--freq 550` меняет тон.

Почему mu-law, а не Opus: `server-sdk-go/pkg/media` кодирует Opus через cgo, а
оба Go-модуля собираются с `CGO_ENABLED=0` (CONTRIBUTING.md). Несжатый PCMU не требует
кодировщика и проходит через SFU как обычная аудиодорожка; спайк 0.1 это
проверил, ADR 0001. Голосовой клиент на Rust публикует Opus — это его забота,
сервер кодек не навязывает.

Проверка медиа с Windows-хоста (гейт G3, ADR 0001) автоматизирована:

```powershell
.\deploy\dev\check-media.ps1 -AdvertiseIP 192.168.1.10
```

Скрипт берёт админ-ссылку из журнала контейнера, создаёт вторую ссылку через
`rostalk-server invite`, запускает два бота на хосте и проверяет, что оба получили
пакеты, а контейнер — UDP-датаграммы на 7882. `ROSTALK_ADVERTISE_IP` должен быть
LAN IP хоста: с `127.0.0.1` клиент на том же ПК медиа не получит.

### 4. Собери клиент

Нужны Visual Studio Build Tools 2022 (C++ workload) и WebView2 Runtime.

```powershell
cd client
npm --prefix ui ci
npm --prefix ui exec -- tauri dev     # окно клиента + Vite
# или из корня: make dev-client
```

Полная release-сборка без установщика (установщик и релиз — `docs/RELEASE.md`):

```powershell
make build-client
# то же самое вручную:
cd client && npm --prefix ui exec -- tauri build --no-bundle
```

Tauri CLI ищет `tauri.conf.json` только в текущем каталоге и ниже, поэтому
запускать его нужно из `client/` (там лежит `src-tauri/`), а не из `client/ui`.
`frontendDist` в конфиге — `../ui/dist`, то есть `client/ui/dist` относительно
`src-tauri`. Сборка через CLI (а не голый `cargo build`) проверяет, что UI
действительно встроился.

### 5. Интеграционные тесты ядра клиента

Тесты `crates/core/tests/server_integration.rs` работают против настоящего
`rostalk-server`: вход, чужой отпечаток сертификата, переподключение после
перезапуска и два клиента, видящие перемещения друг друга. Они помечены
`#[ignore]`, потому что сервер нужно поднять.

В Linux тест сам запускает собранный сервер на свободном loopback-порту:

```bash
cd server && CGO_ENABLED=0 go build -trimpath -o /tmp/rostalk-server ./cmd/rostalk-server
cd ../client/src-tauri
ROSTALK_SERVER_BIN=/tmp/rostalk-server \
  cargo test -p rostalk-core --test server_integration -- --ignored --test-threads=1
```

На Windows сервер уже идёт в Docker Desktop. Ссылка и команды берутся из
текущего окружения; `--data=/data` — том compose, а пути к `compose.yaml`
абсолютные, потому что `cargo test` запускает команды из каталога крейта:

```powershell
$env:ROSTALK_TEST_LINK = "rostalk://join?host=<LAN IP>:7443&fp=...&invite=..."
$env:ROSTALK_TEST_INVITE_CMD = "docker compose -f <repo>\deploy\dev\compose.yaml exec -T server rostalk-server invite --data=/data --public-host=<LAN IP> --listen=:7443"
$env:ROSTALK_TEST_RESTART_CMD = "docker compose -f <repo>\deploy\dev\compose.yaml restart server"
cd client/src-tauri
cargo test -p rostalk-core --test server_integration -- --ignored --test-threads=1
```

Без `ROSTALK_TEST_INVITE_CMD` тест двух клиентов пропускается: второй
пользователь входит по отдельному инвайту (`rostalk-server invite`), а не по
одноразовой админ-ссылке.

### 6. Интеграционные тесты голосового движка

`crates/voice/tests/media_integration.rs` проверяет тракт целиком: бот с
WAV-файлом слышен в записи клиента (и минуту держится в бюджете потерь и
джиттера), тон клиента доходит до бота, self mute останавливает пакеты у бота и
возвращает их после unmute, отпущенный push-to-talk закрывает гейт, продление
токена не рвёт публикацию, а смена канала не уводит медиа в `Idle` и после неё
клиент слышит бота, который ждал в новом канале (краткий провал при смене
допустим — ADR 0011). Тесты помечены `#[ignore]`: нужен сервер и собранный
`rostalkctl`. Микрофон и динамики заменяются файлами (feature `test-audio`),
поэтому железо не требуется.

`crates/voice/tests/audio_quality.rs` — измерения качества:
непрерывность файловой петли, THD+N, подавление шума в паузах, AEC ERLE,
щелчки на границах тишины и два прогона по минуте без underrun (в простое и
под нагрузкой CPU). Запуск: `make test-voice-quality` (Windows). Пороговые
значения — в самом тесте.

Два теста без сервера (петля микрофона и событие состояния) запускаются
обычным `cargo test -p rostalk-voice --features test-audio`.

На Windows против dev-сервера в Docker Desktop:

```powershell
cd tools/rostalkctl; $env:CGO_ENABLED="0"; go build -o ..\..\target\rostalkctl.exe .
cd ..\..\client\src-tauri
$env:ROSTALK_TEST_LINK = "rostalk://join?host=<LAN IP>:7443&fp=...&invite=..."
$env:ROSTALK_TEST_INVITE_CMD = "docker compose -f <repo>\deploy\dev\compose.yaml exec -T server rostalk-server invite --data=/data --public-host=<LAN IP> --listen=:7443"
$env:ROSTALK_HCTL_BIN = "<repo>\target\rostalkctl.exe"
cargo test -p rostalk-voice --features test-audio --test media_integration -- --ignored --test-threads=1
```

На Linux те же тесты могут сами запустить сервер: задайте
`ROSTALK_SERVER_BIN` вместо `ROSTALK_TEST_LINK`/`ROSTALK_TEST_INVITE_CMD`.

Бот умеет играть WAV: `rostalkctl bot <ссылка> --channel <канал> --play
tools/rostalkctl/testdata/quality.wav --loop --duration 60s`. Файл
сгенерирован (`go run testdata/generate.go`), чужой музыки в репозитории нет;
тон (`--tone`) остаётся для проверки маршрута.

### 7. Как устроено управление голосом

- **Self mute** останавливает передачу, а не только «обнуляет» звук: движок
  перестаёт кормить публикатор кадрами и глушит саму публикацию
  (`LocalTrackPublication::mute`), поэтому бот перестаёт получать пакеты.
  Петля mic test тоже глушится — иначе выключенный микрофон слышно в наушниках
  и кажется, что mute не работает. В push-to-talk петля следует кнопке:
  отпущенный PTT глушит и передачу, и локальный монитор, а индикатор уровня
  внизу не двигается, пока кнопка не нажата.
- **Self mute/deafen переживают перезапуск**: флаги лежат в `profile.json`
  (`selfMuted`, `selfDeafened`), движок стартует с ними, а ядро повторяет
  `SetVoiceState` на каждой новой сессии, включая reconnect (долг 2.2). Live-тест
  `self_mute_survives_a_reconnect` в `crates/core/tests/server_integration.rs`
  проверяет это на настоящем перезапуске сервера.
- **Push-to-talk** по умолчанию привязан только к X1/X2
  (`client/src-tauri/src/ptt.rs`). Глобальный ввод идёт через Raw Input
  (`RegisterRawInputDevices` + `RIDEV_INPUTSINK | RIDEV_DEVNOTIFY`, ADR 0012), без
  низкоуровневых `WH_*`-хуков, инъекции и чтения памяти: это важно для
  Vanguard. По умолчанию регистрируется только мышь (X1/X2); клавиатурный
  Raw Input включается лишь при явном `ROSTALK_PTT_KEY`, чтобы не держать
  фоновый захват всех клавиш. Клавиша не является дефолтом (набор в игре/чате
  открывал бы микрофон); остальное настраивается в интерфейсе.
  Ошибка установки или платформа без Raw Input видны в панели управления:
  под ником появляется «PTT недоступен» с текстом ошибки в подсказке, а в
  режиме PTT — текущая привязка. При отпускании кнопки гейт закрывается и
  пакеты прекращаются (live-тест `released_push_to_talk_stops_the_packets`).
- **Античиты (Vanguard).** RosTalk не инжектится в игру, не читает память, не
  ставит kernel-драйвер, не поднимает права и не использует низкоуровневые
  хуки. PTT — Raw Input, тот же API, которым пользуется сама игра. Это
  снижает риск, но не гарантирует совместимость: политика Vanguard закрыта.
  Живой прогон Valorant — гейт G7, пока не подтверждён; если Vanguard
  заблокирует клиент, это баг совместимости, а не повод обходить античит.
  Подробности — `docs/anticheat.md`.
- **Индикатор связи** внутри канала считается по `VoiceStats`: пинг, потери,
  джиттер и прирост playback-underrun/publish-overflow между снимками; три
  градации (`excellent`/`good`/`fair`). Вне голосового канала — точка «на
  связи», без выдуманных палок. Маппинг покрыт `src/lib/quality.test.ts`.
- **ПКМ**: нативное меню WebView2 отключено в оболочке
  (`AreDefaultContextMenusEnabled=false`). Вместо него страница показывает
  маленькое меню «Вырезать/Копировать/Вставить/Выделить всё» для полей и
  «Копировать» для выделенного текста; вставка читает буфер обмена через
  `rostalk-platform` (Chromium не разрешает `execCommand("paste")`). Ctrl+C/Ctrl+V
  продолжают работать сами по себе. Проверки — `e2e/context-menu.spec.ts`.

## Порты

| Порт | Назначение |
|---|---|
| TCP 7443 | HTTPS/WSS: протокол управления, сигналинг LiveKit (`/rtc`), HTTP API |
| TCP 7881 | запасной путь медиа по TCP (ICE-TCP) |
| UDP 7882 | весь медиа-трафик |

В `deploy/dev/compose.yaml` опубликованы все три; `--network host` в dev не
используется (в Docker Desktop он работает не так, как в Linux).

## Команды make

| Команда | Что делает |
|---|---|
| `make setup` | `npm ci`, `go mod download` для всех модулей и protoc-плагины |
| `make tools` | только запиненные protoc-плагины (для `make gen`) |
| `make gen` | перегенерировать Go/Rust/TypeScript из `proto/rostalk/v1` |
| `make check` | полная проверка: proto, оба Go-модуля, Rust, UI, античит, сгенерированный код |
| `make dev-server` | сервер из исходников (Linux) |
| `make dev-client` | окно клиента + Vite |
| `make dev-server-docker` | образ и контейнер dev-сервера |
| `make test-server-docker` | тесты сервера в Linux-контейнере с `-race` |
| `make build-server` / `make build-client` | серверный бинарник / UI + Tauri-оболочка (`--no-bundle`) |
| `make build-server-setup` | установщик сервера для Windows `rostalk-server-setup.exe` |
| `make release VERSION=x.y.z` | весь релиз в `dist/release-x.y.z` (docs/RELEASE.md, ADR 0026) |
| `make publish-release VERSION=x.y.z [DRY_RUN=1]` | публикация на GitHub Releases (`gh`, запускает мейнтейнер) |
| `make proto-breaking` | сравнить контракт с `origin/main` (`BUF_BASE=...` меняет базу) |
| `make install-hooks` | включить `.githooks/` (быстрые проверки перед коммитом) |

Инструменты можно переопределить: `make check GO=/usr/local/go/bin/go`.

## Протокол

`proto/rostalk/v1` — источник истины. Один TLS WebSocket, бинарные
Protobuf-кадры, запрос-ответ по `request_id` / `reply_to`, плюс события сервера.

| Файл | Содержимое |
|---|---|
| `protocol.proto` | `ClientFrame`, `ServerFrame`, версия протокола, правила совместимости |
| `handshake.proto` | `Hello`, `Challenge`, `Authenticate`, `Welcome` (Ed25519) |
| `state.proto` | снимок: сервер, каналы, пользователи, роли, свои права |
| `channels.proto` | вход/выход из канала, `SetVoiceState`, `MediaCredentials` |
| `events.proto` | `UserJoined/Left/Moved/Updated`, `ChannelCreated/Updated/Deleted`, `ServerUpdated` |
| `error.proto` | `Error` и коды ошибок |

Правила:

1. Меняешь `.proto` — в том же коммите `make gen`: сгенерированный код лежит в
   репозитории, `make check` падает при расхождении.
2. Несовместимые изменения wire-формата запрещены без `rostalk.v2`. `make check`
   проверяет это через `buf breaking` против базовой ветки.
3. Каждое поле описано комментарием: контракт — это документация.

Сгенерированное:

| Язык | Куда | Плагин |
|---|---|---|
| Go | `proto/gen/go/rostalk/v1` | `protoc-gen-go` (запинен в Makefile) |
| Rust | `client/src-tauri/crates/core/src/proto/rostalk.v1.rs` | `protoc-gen-prost` (запинен в Makefile) |
| TypeScript | `client/ui/src/proto/rostalk/v1` | `protoc-gen-es` (запинен в `client/ui/package.json`) |

Генерация **локальная и офлайновая**: `make gen` (и `make check`) сами ставят
запиненные плагины в `bin/protogen` и в `client/ui/node_modules`, buf запускает
их как обычные исполняемые файлы. Buf Schema Registry не используется — ни
лимитов, ни «плавающих» версий плагинов. Нужны только Go, Rust и Node; сеть —
только на первую установку зависимостей. `make gen` детерминирован: повторный
прогон не меняет ни одного файла.

## Сборка и проверка

Хостингового CI нет (ADR 0015). Приёмка локальная:

```powershell
make check          # Go, Rust, UI, voice, bindings, generated
make build-client   # release MSVC
# затем запустить client/src-tauri/target/release/rostalk.exe
```


## Хуки

```sh
make install-hooks     # git config core.hooksPath .githooks
# либо, если пользуешься pre-commit:
pre-commit install
```

Хук делает быстрые проверки (`buf lint`/`format`, `gofmt`, `rustfmt`,
пробелы в staged-диффе). Полный набор — `make check`.
