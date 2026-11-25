# ADR 0026. Раздельная поставка: клиент, установщик сервера, GitHub Releases

- **Статус:** принято (этап P13, решение владельца по D2 от 2026-11-23)
- **Дата:** 2026-11-23
- **Связано:** жалоба 3 playtest-1 (`docs/PLAYTEST-1_PLAN.md`), ADR 0015
  (локальная сборка без CI), ADR 0019 (обновление клиента), ADR 0021
  (установка сервера по SSH), ADR 0023 (навигация WebView), аудит
  `docs/security/2026-11-22-anticheat-review.md` (P0-1 Authenticode)
- **Меняет:** ADR 0021 п. 4 (бинарники сервера в составе клиента) и п. 5
  (кнопка «Свой хостинг» в клиенте); ADR 0019 п. 1 (источник по умолчанию)

## Контекст

На playtest-1 клиент раздавался папкой `rostalk-client-portable`: `rostalk.exe`
и рядом `server/` с двумя серверными бинарниками (~45 МБ). Игрокам, которые
только подключаются к чужому серверу, сервер не нужен; мастер «Свой хостинг»
в клиенте путал и тащил в клиент SSH (`russh`) — лишнюю поверхность для
антивирусов и ревью. Раздавать сборки было негде: файлы пересылались руками
(жалоба 3).

Хостингового CI нет и не будет без решения владельца (ADR 0015). Владелец
решил (D2): репозиторий `v4dikos1/RosTalk` становится публичным, релизы
публикуются в нём на GitHub Releases. Ассеты публичного репозитория
скачиваются без авторизации — это нужно и `install.sh` (`curl | sh`), и
апдейтеру клиента.

## Решение

### 1. Три поставки вместо одной

| Пакет | Для кого | Что внутри |
|---|---|---|
| `RosTalk-Setup-<v>.exe` | все игроки | NSIS `currentUser` из этапа 6.2: `rostalk.exe`, `rostalk://`, автозапуск по желанию, подписанное обновление. Без `server/` и без SSH |
| `RosTalk-<v>-portable.zip` | без установки | `rostalk.exe` + README |
| `RosTalk-Server-Setup-<v>.zip` | владельцы серверов на Windows | `rostalk-server-setup.exe` + `server/` (подписанный релиз сервера той же версии) + README |
| `rostalk-server_<v>_linux_{amd64,arm64}`, `install.sh` | владельцы серверов на Linux | `curl …/releases/latest/download/install.sh \| sudo sh` |
| `latest.json` | апдейтер клиента | манифест Tauri: версия, подпись minisign, URL установщика этого релиза |
| `SHA256SUMS`, `SHA256SUMS.sig` | все | SHA-256 каждого файла релиза, подпись Ed25519 ключом релиза |

### 2. `rostalk-server-setup` — отдельное приложение

- Новый член Cargo workspace клиента `client/src-tauri/apps/server-setup`
  (пакет `rostalk-server-setup`): Tauri 2 тех же версий, что клиент, без трея,
  плагинов, single-instance и глобального ввода. Использует `crates/hosting`
  (без изменений) и `hosting_ipc.rs`, перенесённый из клиента как есть
  (`git mv`), включая хранение паролей в Credential Manager под прежним
  сервисом `dev.rostalk.hosting`.
- UI — вторая точка входа Vite: `client/ui/server-setup.html` →
  `src/server-setup/main.tsx` → `features/hosting/HostingWizard` (во всё окно,
  IPC — через проп `HostingApi`). Сборка `vite build --mode server-setup` идёт в
  `client/ui/dist-server-setup`; клиентская `dist` мастер не содержит.
  Привязки IPC — `src/server-setup/bindings.ts` (`make gen-ipc`, проверяются в
  `make check`).
- Окно создаётся кодом с тем же navigation guard, что у клиента (ADR 0023), и
  без контекстного меню WebView2. Capability — только `core:default`.
- Шаг 4 мастера больше не подключает: он показывает админ-ссылку и ссылку для
  друзей с кнопками «Копировать» и подсказку вставить ссылку в клиенте.
- Поставка — portable: exe и `server/` в одном zip; NSIS не нужен
  (приложению нечего регистрировать в системе).

### 3. Клиент без сервера

- Из клиента ушли `rostalk-hosting`, команды `hosting_*`, событие хостинга и
  `HostingState`; Windows-граф зависимостей клиента больше не содержит
  `russh`.
- Вместо мастера на экране подключения, в меню «Ещё» и в онбординге — «Хочу
  свой сервер»: короткое объяснение, адрес страницы релизов и команда для
  Linux, у каждого — кнопка «Копировать». Браузер клиент не открывает:
  `ShellExecuteW` нет в белом списке античит-гигиены (ADR 0023, C-13 в
  `docs/REVIEW.md`).

### 4. Репозиторий релизов — переменная сборки

`make release RELEASE_REPO=owner/name` (по умолчанию `v4dikos1/RosTalk`) — одно
значение для всех мест:

- клиент (Rust): `ROSTALK_RELEASE_REPO` на этапе сборки
  (`client/src-tauri/src/updates.rs`, `build.rs`) → источник обновлений по
  умолчанию `https://github.com/<repo>/releases/latest/download/latest.json`;
- клиент (UI): то же значение через `define` Vite (`client/ui/vite.config.ts`,
  `src/lib/release.ts`) → адрес страницы релизов и команда для Linux;
- `install.sh`: `make release` записывает репозиторий в значение по умолчанию
  `RELEASE_REPO=${ROSTALK_RELEASE_REPO:-…}` копии, которая публикуется;
- `latest.json`: URL установщика
  `https://github.com/<repo>/releases/download/v<v>/RosTalk-Setup-<v>.exe`;
- `make publish-release`: `gh release create --repo <repo>`.

Значение проверяется (`owner/name`, только `[A-Za-z0-9._-]`) в Vite, в
`install.sh`, в `release-all.sh` и тестом Rust.

### 5. Цепочка доверия и подписи

1. **Ed25519 (ключ релиза сервера, как в 6.1).** `SHA256SUMS` релиза покрывает
   все файлы и подписан `rostalk-sign`; публичная половина —
   `deploy/release.pub`, она же вшита в `install.sh`, серверные бинарники и
   клиент установщика. `install.sh` и `rostalk-server update` проверяют
   подпись до того, как тронуть систему; GitHub — только транспорт. Бандл
   внутри `RosTalk-Server-Setup` имеет свой `SHA256SUMS` того же ключа (формат
   6.1a).
2. **minisign (ключ апдейтера, как в 6.2).** Tauri подписывает установщик при
   сборке; подпись попадает в `latest.json`; клиент проверяет её перед
   запуском установщика (`requireSignedVersion`).
3. **Authenticode — необязательный шаг** (сертификата пока нет). Если в
   окружении или в локальном `%USERPROFILE%\.rostalk\release\signing.env` есть
   `ROSTALK_AUTHENTICODE_THUMBPRINT` + `ROSTALK_AUTHENTICODE_TIMESTAMP_URL` или
   `ROSTALK_AUTHENTICODE_COMMAND`, `make release` передаёт их Tauri как
   `bundle.windows.certificateThumbprint/digestAlgorithm/timestampUrl/tsp` или
   `signCommand` (`tauri build --config`, поля сверены с `tauri-utils` 2.10.4,
   который тянет Tauri 2.12), подписывает `rostalk-server-setup.exe` тем же
   `signtool` (SHA-256, RFC 3161) или той же командой и проверяет все три exe
   `signtool verify /pa`. Иначе пишет «НЕ ПОДПИСАНО» и продолжает. Установщик
   после Tauri не переподписывается: это сломало бы подпись апдейтера.

Ключи и пароли в репозиторий и в лог не попадают: скрипты читают пути из
переменных (`ROSTALK_SIGN_KEY`, `TAURI_SIGNING_PRIVATE_KEY`) с умолчаниями вне
репозитория и печатают только имена файлов.

Варианты сертификата Authenticode (решает владелец, CI без решения не
добавляется):

- **SignPath Foundation** — бесплатно для OSS; нужны OSI-лицензия, сборка на
  GitHub Actions (отступление от ADR 0015 — отдельное решение и ADR) и
  издатель «SignPath Foundation» в подписи;
- **OV-сертификат УЦ** на токене или в облачном HSM + `signtool`;
- **Microsoft Artifact Signing** (бывший Trusted Signing) — для частных лиц
  только США и Канада.

Authenticode остаётся открытым P0 до публичной беты.

### 6. Сборка и публикация без CI

- `make release VERSION=x.y.z` (`deploy/release-all.sh`) на Windows-машине
  сборки собирает всё в чистый `dist/release-x.y.z/`, сверяет версии в
  `tauri.conf.json`/`Cargo.toml` обоих приложений, проверяет `SHA256SUMS` и
  подпись. Сервер собирается кросс-компиляцией `GOOS=linux` тем же
  `deploy/release.sh`, что `make server-bundle` в 6.1a.
- `make publish-release VERSION=x.y.z [DRY_RUN=1]`
  (`deploy/publish-release.sh`) запускает владелец со своим `gh auth login`:
  проверяет состав каталога, `SHA256SUMS` и подпись, что `latest.json` и
  `install.sh` собраны для этого репозитория, что тег `vx.y.z` указывает на
  HEAD, и выполняет `gh release create --verify-tag`. Пре-релизы
  (`x.y.z-rc.N`) публикуются с `--prerelease` и не попадают в
  `releases/latest`.

### 7. Откат релиза

- **Плохой релиз ещё не скачали:** `gh release delete vX.Y.Z --repo <repo>`
  (тег оставить или удалить `git push --delete origin vX.Y.Z`). `latest`
  снова указывает на предыдущий релиз: апдейтер и `install.sh` берут его.
- **Клиенты уже обновились:** апдейтер не откатывает (версия в манифесте
  должна быть новее, ADR 0019). Выпустить исправленную версию `X.Y.Z+1`;
  при необходимости пользователи ставят старый `RosTalk-Setup` поверх вручную
  (NSIS `currentUser` это допускает, `allowDowngrades` по умолчанию).
- **Сервер:** `rostalk-server update --release-url
  https://github.com/<repo>/releases/download/v<старая>` ставит старую
  подписанную версию; `install.sh --version <старая>` — то же. Данные не
  трогаются, перед обновлением `rostalk-server backup`.
- **Утечка ключа:** новый ключ, новая `deploy/release.pub` / `pubkey` в
  `tauri.conf.json`, ручная переустановка (ADR 0019, `docs/RELEASE.md`).

## Последствия

- Клиентский установщик меньше на ~45 МБ и без SSH-кода; у античит-ревью
  одной поверхностью меньше. `make check-anticheat` проверяет граф всего
  workspace (`cargo tree --workspace`), `make check-anticheat-imports` —
  импорты обоих exe тем же списком и тем же baseline.
- Владельцу сервера на Windows нужен второй файл; это осознанная цена.
- Репозиторий релизов должен быть публичным: из приватного ассеты без
  авторизации не скачать, и обновление/`install.sh` молча сломаются.
  `make publish-release` этого не проверяет — проверка в чек-листе релиза.
- GitHub становится источником по умолчанию, но не единственным: свой
  `updateSource`/`ROSTALK_UPDATE_SOURCE` и `install.sh --base-url` работают, как
  раньше.
- Чистая Windows (G5), публикация и Authenticode остаются ручными шагами
  владельца (`docs/RELEASE.md`, чек-лист).
