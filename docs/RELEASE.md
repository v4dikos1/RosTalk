# Выпуск RosTalk (Windows-машина сборки)

Этап 6.2, с P13 — весь релиз: клиент, установщик сервера и серверные
бинарники на GitHub Releases (ADR 0026). Здесь описаны сборка, версия и тег,
источник обновлений, подписи, публикация, ручное обновление, чистое удаление
и откат. Хостингового CI нет: всё выполняется локально на Windows-машине с
MSVC (ADR 0015).

## 0. Релиз целиком (P13)

```powershell
# версии в client/src-tauri/tauri.conf.json, client/src-tauri/Cargo.toml,
# client/src-tauri/apps/server-setup/tauri.conf.json и .../Cargo.toml = 0.3.0
make check
git commit -am "Release 0.3.0"; git tag -a v0.3.0 -m "RosTalk 0.3.0"
make release VERSION=0.3.0                      # dist/release-0.3.0 (+ .notes.md)
make check-anticheat-imports                    # оба exe из этой сборки
make publish-release VERSION=0.3.0 DRY_RUN=1    # проверка и печать команды gh
git push origin main v0.3.0
make publish-release VERSION=0.3.0              # gh release create (логин владельца)
```

Если рабочий репозиторий приватный (ADR 0034), перед `publish-release` в
публичный репозиторий уходит снимок исходников того же коммита, и тег
ставится на него — `gh --verify-tag` ищет тег в `RELEASE_REPO`:

```powershell
git clone https://github.com/v4dikos1/RosTalk.git ..\RosTalk   # один раз
$env:PUBLIC_DIR="..\RosTalk"; $env:COMMIT="1"; $env:MESSAGE="RosTalk 0.3.0"
sh tools/public-export/export.sh                # сканирует и коммитит, не пушит
git -C ..\RosTalk show --stat                  # просмотреть снимок
git -C ..\RosTalk tag -a v0.3.0 -m "RosTalk 0.3.0"
git -C ..\RosTalk push origin main v0.3.0
```

`RELEASE_REPO=owner/name` (по умолчанию `v4dikos1/RosTalk`) меняет репозиторий
во всех местах сразу: источник обновлений клиента по умолчанию, страница
«Хочу свой сервер», `install.sh`, `latest.json`, `gh --repo`. Репозиторий
должен быть публичным.

`make release` пишет в чистый `dist/release-<v>/` (существующий каталог —
ошибка):

| Файл | Откуда |
|---|---|
| `RosTalk-Setup-<v>.exe` | `tauri build` клиента (NSIS `currentUser`, `.sig` апдейтера уходит в `latest.json`) |
| `RosTalk-<v>-portable.zip` | `rostalk.exe` + README (`deploy/portable-client.sh`) |
| `RosTalk-Server-Setup-<v>.zip` | `rostalk-server-setup.exe` + `server/` (подписанный `deploy/release.sh`) + README |
| `rostalk-server_<v>_linux_amd64`, `…_arm64` | `deploy/release.sh` (`GOOS=linux`, `CGO_ENABLED=0`) |
| `install.sh` | `deploy/install.sh` с этим репозиторием по умолчанию |
| `latest.json` | манифест апдейтера: URL `…/releases/download/v<v>/RosTalk-Setup-<v>.exe` |
| `SHA256SUMS`, `SHA256SUMS.sig` | SHA-256 всех файлов выше, подпись Ed25519 ключом релиза |

Ключи (вне репозитория, в лог не печатаются): `ROSTALK_SIGN_KEY` (по умолчанию
`%USERPROFILE%/.rostalk/release/rostalk-release.key`) и `TAURI_SIGNING_PRIVATE_KEY` (по
умолчанию `%USERPROFILE%\.rostalk\release\rostalk-updater.key`, пароль —
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, пустой, если не задан). Authenticode —
необязательно, см. раздел 7 и `docs/INSTALL.md` («Для владельца»): без
настройки сборка пишет «НЕ ПОДПИСАНО».

Для локальной проверки обновления можно собрать версию, не записанную в
исходники: `RELEASE_ALLOW_VERSION_MISMATCH=1` (такую сборку не публиковать).

### Чек-лист релиза (руками владельца)

1. `make check` зелёный, `make release` без ошибок, `make
   check-anticheat-imports` — OK для `rostalk.exe` и `rostalk-server-setup.exe`.
2. Установщик ставится без админа на чистой Windows (G5), `rostalk://`
   работает, в `%LOCALAPPDATA%\RosTalk` нет `server\`.
3. Обновление с предыдущей версии через «Настройки → Обновления».
4. `rostalk-server-setup.exe` ставит сервер на тестовый VPS, ссылка
   подключает клиент.
5. Все файлы — на VirusTotal. Ложные срабатывания — в Microsoft Security
   Intelligence (https://www.microsoft.com/wdsi/filesubmission, «Submit a
   file» → «Software developer») и вендорам антивирусов.
6. `make publish-release`; `SHA256SUMS` и `SHA256SUMS.sig` публикуются
   вместе с релизом. Проверить без входа в GitHub:
   `curl -fsSLI https://github.com/<repo>/releases/latest/download/latest.json`.

## 1. Что нужно один раз

- Visual Studio Build Tools 2022 (MSVC), WebView2 Runtime, Rust MSVC,
  Node.js/npm — по `docs/DEVELOPMENT.md`, раздел «Требования».
- Ключ подписи обновлений Tauri (minisign/Ed25519). Приватный ключ **не
  хранится в репозитории**:

  ```text
  %USERPROFILE%\.rostalk\release\rostalk-updater.key      приватный, не коммитить
  %USERPROFILE%\.rostalk\release\rostalk-updater.key.pub  публичный
  ```

  Публичный ключ уже вписан в `client/src-tauri/tauri.conf.json`
  (`plugins.updater.pubkey`). Приватный ключ без пароля (так его читает
  `make release-client` без интерактивного ввода); храните резервную копию
  **вне репозитория**. Потеря ключа означает, что уже установленные клиенты
  больше не смогут принимать обновления — придётся выпускать новую установку
  и просить пользователей переустановить клиент вручную.
  `tauri.conf.json` включает `requireSignedVersion`: подпись должна содержать
  версию (`version:` в trusted comment). Tauri CLI 2.12 это делает; старые
  CLI, подписывавшие без версии, для релизов не годятся.

  Если ключа нет: `make release-key` (или
  `cd client && npm --prefix ui exec -- tauri signer generate -w
  %USERPROFILE%\.rostalk\release\rostalk-updater.key --ci`). После генерации
  скопируйте содержимое `.key.pub` в `plugins.updater.pubkey`.

- NSIS Tauri скачивает сам при первой сборке установщика. UPX и другие
  упаковщики не используются.

## 2. Версия и тег

Версия живёт в двух местах и должна совпадать:

1. `client/src-tauri/tauri.conf.json` → `version` (её видит апдейтер и UI);
2. `client/src-tauri/Cargo.toml` → `[package] version` (метаданные exe).

Перед выпуском поднимите обе, например `0.1.0` → `0.1.1`, и закоммитьте.
Тег — `v<версия>` (`v0.1.1`) на этом коммите. Обновление устанавливается
только если версия в манифесте **строго больше** установленной.

## 3. Сборка установщика

```powershell
make check
make build-client                 # release-сборка MSVC без установщика
make check-anticheat-imports      # импорты release-exe по baseline
make release-client               # NSIS currentUser + .sig апдейтера
```

`make release-client` читает приватный ключ из
`%USERPROFILE%\.rostalk\release\rostalk-updater.key`; другой путь —
`make release-client UPDATER_KEY=D:/keys/rostalk-updater.key` или
переменная `TAURI_SIGNING_PRIVATE_KEY`.

Результат:

```text
client/src-tauri/target/release/bundle/nsis/RosTalk_<версия>_x64-setup.exe
client/src-tauri/target/release/bundle/nsis/RosTalk_<версия>_x64-setup.exe.sig
```

Установщик:

- ставится в профиль пользователя (`currentUser`,
  `%LOCALAPPDATA%\RosTalk`), без прав администратора и без UAC;
- создаёт ярлыки (меню «Пуск» и рабочий стол) и деинсталлятор;
- регистрирует `rostalk://` в `HKCU\Software\Classes\rostalk`, деинсталлятор
  снимает регистрацию;
- не ставит службы, драйверы, сертификаты, правила файрвола и исключения
  Defender, не просит повышения прав;
- сжимает файлы LZMA; UPX, Themida, VMProtect и обфускация запрещены
  («Античит-гигиена» в `docs/anticheat.md`).

Античит-проверки на релизе:

```powershell
make check-anticheat            # исходники и граф зависимостей
make check-anticheat-imports    # dumpbin /imports release-exe
```

Установщик и деинсталлятор — сторонние (NSIS, Tauri), в baseline импортов
они не входят; проверяется `rostalk.exe`. Если новая зависимость принесла
запрещённый импорт, это вопрос человеку, а не строка в baseline
(`docs/anticheat.md`).

## 4. Манифест обновления

Tauri использует статический `latest.json`:

```json
{
  "version": "0.1.1",
  "notes": "Что нового",
  "pub_date": "2026-11-21T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<содержимое .sig, не путь>",
      "url": "https://downloads.example/rostalk/RosTalk_0.1.1_x64-setup.exe"
    }
  }
}
```

Скрипт собирает его из готового установщика и `.sig`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/client/make-manifest.ps1 `
  -Version 0.1.1 `
  -Installer client/src-tauri/target/release/bundle/nsis/RosTalk_0.1.1_x64-setup.exe `
  -BaseUrl https://downloads.example/rostalk `
  -Notes "Исправлены переподключения" `
  -Out latest.json
```

Для локального/offline-каталога добавьте `-Relative`: манифест назовёт
установщик по имени файла, и клиент прочитает его из того же каталога.

## 5. Источник обновлений

По умолчанию (поле пустое, переменной нет) клиент читает
`https://github.com/<RELEASE_REPO>/releases/latest/download/latest.json`
(P13, ADR 0026). Свой источник задаётся в клиенте: «Настройки →
Обновления → Источник обновлений». Допустимы:

- `https://…/latest.json` — статический манифест по TLS (любой хостинг,
  включая собственный);
- абсолютный путь к локальному каталогу с `latest.json` и установщиком
  (LAN-шара, offline-развёртывание).

Переменная `ROSTALK_UPDATE_SOURCE` переопределяет значение из настроек
(удобно для поддержки и для теста обновления). HTTP (не HTTPS) для URL
запрещён; для офлайна используйте каталог.

Подпись пакета проверяется **всегда**: публичный ключ в
`tauri.conf.json`, подпись — из манифеста. Подделанный или повреждённый
установщик не запускается. Версия из манифеста должна быть строго новее;
откат через апдейтер невозможен.

## 6. Обновление из интерфейса и вручную

Из интерфейса: «Проверить обновления» → показывается версия и заметки →
«Установить и перезапустить». Клиент скачивает установщик, проверяет
подпись, запускает NSIS в passive-режиме и завершается; установщик
перезапускает клиент. **Разговор прерывается только после подтверждения**;
кнопка «Позже» ничего не меняет. Прогресс скачивания виден в настройках.

Вручную (второй путь): скачайте `RosTalk_<версия>_x64-setup.exe` с тем же
`latest.json`/страницы релиза, закройте клиент и запустите установщик.
Поверх старой версии настройки, личность и серверы сохраняются. Сверьте
SHA-256 с опубликованным, если он есть; подпись апдейтера проверяет только
клиент при обновлении из UI, вручную установщик проверяется подписью кода
(см. ниже).

## 7. Подпись кода Windows

Подпись апдейтера (minisign) и подпись кода (Authenticode) — разные вещи.
Первая обязательна и уже настроена; вторая влияет на предупреждения Windows.

С P13 `make release` подписывает сам, если в окружении или в
`%USERPROFILE%\.rostalk\release\signing.env` заданы
`ROSTALK_AUTHENTICODE_THUMBPRINT` + `ROSTALK_AUTHENTICODE_TIMESTAMP_URL` или
`ROSTALK_AUTHENTICODE_COMMAND`; `tauri.conf.json` для этого не меняется (поля
`bundle.windows` передаются через `tauri build --config`). Три пути получить
сертификат и порядок — `docs/INSTALL.md`, «Для владельца», и ADR 0026.

Что нужно:

- сертификат подписи кода (OV или EV; для нового издателя без репутации
  SmartScreen всё равно покажет предупреждение, пока репутация не наберётся);
  варианты — покупка у удостоверяющего центра (Sectigo, DigiCert и т. п.)
  или Azure Trusted Signing;
- `signtool` из Windows SDK;
- в `client/src-tauri/tauri.conf.json` → `bundle.windows`:
  `certificateThumbprint` и `timestampUrl` (или `signCommand` для
  Azure Trusted Signing/кастомного HSM). Одна подпись на `rostalk.exe` и все
  поставляемые DLL; чужие подписи не трогаем. Tauri подписывает установщик
  и exe; если появится своя DLL, подпишите её тем же сертификатом в
  `signCommand`.

Что увидит пользователь **без** подписи кода:

- SmartScreen: «Windows защитила ваш компьютер», «Неизвестный издатель»;
  нужно «Подробнее → Выполнить в любом случае»;
- в свойствах exe — нет вкладки «Цифровая подпись»;
- антивирусы могут показать предупреждение о новом неизвестном установщике;
- Defender/античит-политики это не нарушает, но доверия меньше.

Подпись кода не даёт никаких привилегий и не добавляет служб/драйверов; она
не заменяет проверку подписи апдейтера.

## 8. Автозапуск

Опция «Запускать вместе с Windows» (по умолчанию выключена) пишет
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\RosTalk` со значением
`"<путь>\rostalk.exe" --minimized` через `tauri-plugin-autostart`. Клиент
стартует свёрнутым в трей, голос и трей работают. Деинсталлятор удаляет
запись. Службы, задачи планировщика и запуск от SYSTEM не используются.

## 9. Чистое удаление

`uninstall.exe` удаляет установку, ярлыки, деинсталлятор, ключ
`HKCU\Software\Classes\rostalk` и запись автозапуска.

Личность и настройки:

- на странице подтверждения есть флажок Tauri «Удалить данные приложения»
  (`Delete application data`); если он отмечен, данные и ключ удаляются;
- если флажок не отмечен (вид по умолчанию), деинсталлятор задаёт один вопрос
  «Оставить личность и настройки?»; **по умолчанию и в тихом режиме — удалить**,
  сохранение требует явного «Да»;
- тихий/пассивный деинсталлятор (`/S`, `/P`) всегда удаляет данные;
- удаляются ключ из Windows Credential Manager,
  `%APPDATA%\dev.rostalk.desktop` (серверы, настройки) и
  `%LOCALAPPDATA%\dev.rostalk.desktop` (данные WebView);
- при «Да» (и не отмеченном флажке) личность и настройки остаются;
  повторная установка их подхватит.

Проверено: установка → удаление с удалением данных и удаление с сохранением
данных (см. отчёт этапа). Если нужно сохранить личность перед удалением,
сделайте экспорт в «Настройки → Личность».

## 10. Откат

- Апдейтер откат не делает: версия в манифесте должна быть новее.
- Ручной откат: закройте клиент, запустите установщик предыдущей версии
  поверх текущей (NSIS `currentUser` это допускает) или удалите клиент
  (с сохранением данных) и поставьте старую сборку.
- Если новая версия сломана, уберите/исправьте `latest.json` на источнике:
  клиенты перестанут видеть обновление. Уже обновившиеся откатываются вручную.
- Настройки и личность при откате совместимы: формат `settings.json`
  версионирован, миграции выполняются на старте.

## 11. Что остаётся ручным (G5)

- Установка на **чистую** Windows без Visual Studio/WebView2: проверить
  `downloadBootstrapper` (WebView2), ярлыки, `rostalk://` из мессенджера,
  автозапуск после перезагрузки, удаление с сохранением и без.
- Обновление N → N+1 через UI на чистой машине и обновление поверх
  запущенного клиента (закрытие, перезапуск, сохранение настроек).
- Подпись кода: поведение SmartScreen с сертификатом; без сертификата
  предупреждение ожидаемо.
- Живой прогон Vanguard (G7) не относится к установщику, но релизный exe
  должен запускаться при работающем античите.
