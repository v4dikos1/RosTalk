# Античит-гигиена

Граница проекта для клиента под Windows: что ему запрещено, что разрешено и
как это проверяется автоматически.

## Правила

RosTalk запускают параллельно с играми под kernel-level античитами: Riot Vanguard
(Valorant, LoL), Easy Anti-Cheat, BattlEye, FACEIT. Политики античитов закрыты и
меняются, поэтому гарантию даёт только поведение: **RosTalk — обычное
user-mode-приложение, которое работает только со своим процессом, своими окнами,
своими аудиоустройствами и сетью.** Всё, что похоже на чит, макрос, оверлей с
инъекцией или скрытность, запрещено, даже если «технически безопасно».

Главное правило: **API нет в белом списке — значит, его нельзя.** Нужен — сначала
ADR с обоснованием, без кода. Решение принимает мейнтейнер после живого прогона
с античитом (гейт G7).

### Запрещено всегда

| Категория | Запрещённые Win32 API / механизмы | Запрещённые крейты / пакеты |
|---|---|---|
| Чужие процессы | `OpenProcess`, `OpenThread` для чужих PID, `ReadProcessMemory`, `WriteProcessMemory`, `VirtualAllocEx`, `VirtualProtectEx`, `CreateRemoteThread(Ex)`, `NtCreateThreadEx`, `QueueUserAPC`, `SetThreadContext`, `DuplicateHandle` из чужого процесса, `DebugActiveProcess`, `MiniDumpWriteDump`, `NtQuerySystemInformation` (список хэндлов/процессов) | `sysinfo`, `process-memory`, `read-process-memory`, `dll-syringe`, `windows`/`windows-sys` с фичами `Win32_System_Diagnostics_Debug`, `Win32_System_Diagnostics_ToolHelp`, `Win32_System_ProcessStatus` |
| Перечисление процессов | `CreateToolhelp32Snapshot`, `Process32First/Next`, `Module32*`, `EnumProcesses`, `EnumProcessModules`, WMI `Win32_Process`; функции вида «во что играет друг» и автодетект игр | те же |
| Хуки и инъекции | `SetWindowsHookEx` (**любой** `WH_*`, включая `WH_KEYBOARD_LL`/`WH_MOUSE_LL` как fallback), `SetWinEventHook`, `AppInit_DLLs`, Image File Execution Options, COM-hijack, Vulkan implicit layers, хуки DirectX/OpenGL, DLL в чужом процессе | `rdev`, `willhook`, `inputbot`, `retour`, `detour`, `minhook`, `ilhook` |
| Синтетический и перехваченный ввод | `SendInput`, `keybd_event`, `mouse_event`, `PostMessage`/`SendMessage` с вводом в чужие окна, `BlockInput`, `ClipCursor`, `SetCursorPos`; Raw Input с флагами `RIDEV_NOLEGACY`, `RIDEV_CAPTUREMOUSE`, `RIDEV_NOHOTKEYS`, `RIDEV_APPKEYS`; опрос `GetAsyncKeyState`/`GetKeyState` в цикле; драйверы Interception, vJoy, ViGEm; макросы и ремап клавиш | `enigo`, `winput`, `device_query`, `autopilot`, `vigem-client` |
| Чужие окна | `FindWindow`/`EnumWindows` для поиска игры, `GetWindowText` чужих окон вне выбора источника стрима (5.2), `SetWindowPos`/`SetParent`/`SetWindowLong` на чужом окне, `PrintWindow`/`BitBlt` с DC игры, UI Automation по чужим приложениям | — |
| Ядро и система | любые драйверы (`.sys`, фильтры, WFP-callout, Npcap/WinPcap), `SeDebugPrivilege`, `SeLoadDriverPrivilege`, `AdjustTokenPrivileges`, манифест `requireAdministrator`, обход UAC, службы клиента от SYSTEM, `bcdedit`/testsigning, правки файрвола и `hosts` из клиента, исключения Defender, отключение SmartScreen, установка сертификатов в хранилище Windows (CA пинится в приложении, ADR 0004) | — |
| Скрытность и обфускация | упаковщики (UPX, Themida, VMProtect), шифрование строк, антиотладка (`IsDebuggerPresent`-проверки, `NtSetInformationThread(HideFromDebugger)`), случайные имена exe/окон/классов, скрытие процесса или окна от захвата (`SetWindowDisplayAffinity`), самомодификация, `VirtualAlloc` с `PAGE_EXECUTE*` в нашем коде, загрузка и запуск кода из сети в обход подписанного апдейтера (6.2), неподписанные DLL из каталогов, куда пользователь может писать | `obfstr`, `litcrypt`, любые packer-обёртки |
| Приоритеты | `REALTIME_PRIORITY_CLASS`, `SetPriorityClass` для чужих процессов, привязка к ядрам (`SetProcessAffinityMask`) | — |

### Разрешено (белый список)

- **PTT и хоткеи:** Raw Input — `RegisterRawInputDevices` только с флагами
  `RIDEV_INPUTSINK` и `RIDEV_DEVNOTIFY` на своём message-only окне, ввод не
  подавляется (ADR 0012). Fallback — `RegisterHotKey`/`tauri-plugin-global-shortcut`.
  По умолчанию только X1/X2, printable-клавиша — явная настройка пользователя.
- **Аудио:** WASAPI через `cpal`; MMCSS `AvSetMmThreadCharacteristicsW("Audio")`;
  `SetThreadPriority` до `THREAD_PRIORITY_TIME_CRITICAL` **для своих** аудиопотоков;
  `timeBeginPeriod(1)`; системный loopback (5.1/5.2); process loopback через
  `ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
  (5.2, без открытия процесса игры).
- **Захват экрана:** `getDisplayMedia` в WebView2, Windows.Graphics.Capture, DXGI
  Desktop Duplication — источник выбирает пользователь в системном или нашем
  пикере. Без хуков в игру.
- **Окна:** свои окна Tauri, трей, своё прозрачное always-on-top click-through
  окно для будущего оверлея (только по отдельному ADR, без инъекции).
- **Система:** Credential Manager для своего ключа, автозапуск через
  `HKCU\...\Run` (6.2), обработчик `rostalk://`, установка в профиль пользователя
  без прав администратора, подпись кода (6.2).

### Серая зона — только через ADR и G7

Сюда относится всё, чего нет в белом списке, но что касается ввода, чужих окон
и процессов или настроек системы. Например: список окон для выбора приложения в
5.2, оверлей, новая нативная зависимость с вызовами Win32 Input/Process/Window,
сбор диагностики о системе. Порядок такой: ADR (что вызываем, зачем, какие права
у хэндлов, чем рискуем, как откатить) → флаг, выключенный по умолчанию →
живой прогон с работающим Vanguard (Valorant) и EAC-игрой → только потом
включение по умолчанию. Если античит блокирует или ругается — честно записать
«не поддерживается» и не обходить.

### Как это проверяется

1. `make check-anticheat` (входит в `make check`):
   - grep исходников `client/src-tauri/**/*.rs`, `client/src-tauri/**/Cargo.toml`,
     `client/ui/src/**` по списку `tools/anticheat/denylist.txt` (регулярки
     из таблицы выше);
   - `cargo tree` клиента не содержит запрещённых крейтов;
   - фичи `windows`/`windows-sys` в **наших** `Cargo.toml` не из запрещённого списка;
   - исключения — только в `tools/anticheat/allowlist.txt` в формате
     `путь:шаблон # ADR NNNN`, и каждое исключение одобряет мейнтейнер.
2. Локальная release-сборка: `dumpbin /imports` для `rostalk.exe` сверяется со
   списком запрещённых импортов (`tools/anticheat/forbidden-imports.txt`) целью
   `make check-anticheat-imports` после `make build-client` (ADR 0015; хостингового CI нет).
   Импорты из транзитивных зависимостей (tao, WebView2, libwebrtc), которые были
   до 2.3.3, фиксируются в `tools/anticheat/imports-baseline.txt` с указанием
   крейта. **Новый** запрещённый импорт роняет проверку.
3. Регрессионные тесты модулей (как тест `hotkey.rs` против `SetWindowsHookEx`).
4. Живой прогон G7 перед каждым релизом, который меняет ввод, окна, захват
   или установщик.

## Инструменты

Две проверки, разные по смыслу:

| Что | Чем | Когда | Нужна сборка |
|---|---|---|---|
| Исходники и граф зависимостей | `tools/anticheat/check.sh` (+ `selftest.sh`) | `make check` на любой платформе | нет |
| Импорты release-бинарника | `tools/anticheat/imports.ps1` | вручную на Windows после `make build-client` | да |

## `make check-anticheat`

```sh
make check-anticheat
```

На Windows make вызывает `C:/Program Files/Git/bin/sh.exe` (Git for Windows не
кладёт `sh` в PATH). Другой интерпретатор — `make check-anticheat
ANTICHEAT_SH=sh`, если команда запускается из Git Bash. На Linux — обычный `sh`.
Цель входит в `make check` и не требует `target/` или собранного exe.

Что делает `check.sh`:

1. **Исходники.** Один `grep -rnIEo` по правилам `tools/anticheat/denylist.txt`
   по `client/src-tauri` (кроме `target/`, `gen/` и сгенерированных
   `crates/core/src/proto/`) и по `client/ui/src`. Совпадение печатается как
   `файл:строка`, `match` и строка кода; выход 1.
2. **Граф зависимостей.** `cargo tree --manifest-path
   client/src-tauri/Cargo.toml -e normal --target x86_64-pc-windows-msvc`:
   запрещённые крейты из того же `denylist.txt` (строки-идентификаторы вроде
   `rdev` работают и как регулярка по исходникам, и как имя пакета) — выход 1.
   Фичи `windows`/`windows-sys` (`Win32_System_Diagnostics_ToolHelp` и т. п.)
   ловятся первым пунктом: они перечислены в наших `Cargo.toml`.

`selftest.sh` доказывает, что линтер не «зелёный всегда»: создаёт временный
`.rs` с `SetWindowsHookExW`, `SendInput`, `NtReadVirtualMemory`,
`CreateServiceW`, строкой `chromeMediaSource` и строкой `unsafe-eval` и
требует падения, затем файл с упоминанием тех же имён только в комментарии —
и требует прохода. Временные файлы удаляются, репозиторий не меняется.

### Что добавлено аудитом 2026-11-22

`denylist.txt` расширен по итогам внутреннего аудита античит-рисков 2026-11-22:

- прямые NT-вызовы и чужое адресное пространство: `NtReadVirtualMemory`,
  `NtWriteVirtualMemory`, `NtProtectVirtualMemory`, `NtAllocateVirtualMemory`,
  `NtOpenProcess`, `NtQueryInformationProcess`, `NtOpenThread`,
  `NtSuspendThread`/`NtResumeThread`, `NtMapViewOfSection`, `NtQueryObject`,
  `RtlCreateUserThread`, `Wow64SetThreadContext`, `SuspendThread`,
  `ResumeThread`, `TerminateThread`, `VirtualProtect`;
- токены, службы, драйверы и запуск процессов: `OpenProcessToken`,
  `DuplicateTokenEx`, `ImpersonateLoggedOnUser`, `CreateProcess*`,
  `ShellExecute*`, `WinExec`, `CreateService*`, `OpenSCManager*`,
  `StartService*`, `ChangeServiceConfig*`, `DeleteService`, `NtLoadDriver`,
  `DeviceIoControl`;
- чужие окна: `GetForegroundWindow`, `GetWindowThreadProcessId`,
  `EnumChildWindows`, `GetWindowDC`, `GetKeyboardState`, `ToUnicodeEx`,
  `AttachThreadInput`;
- обновления и WebView2: `unsafe-eval`, `chromeMediaSource`,
  `desktopCapturer`, `disable-web-security`, `allow-running-insecure-content`,
  `ignore-certificate-errors`, `dangerousInsecureTransportProtocol`,
  `dangerousAcceptInvalidCerts`, `allowDowngrades`;
- системные настройки: `Set-MpPreference`, `New-NetFirewallRule`,
  `Disable-WindowsOptionalFeature`, `Uninstall-WindowsFeature`;
- крейты: `ntapi` и `memexec`.

`forbidden-imports.txt` получил те же символы, которых сейчас нет в release-exe
(`OpenProcessToken`, `NtReadVirtualMemory`, `CreateRemoteThreadEx`,
`MiniDumpWriteDump`, `NtQuerySystemInformation`, `EnumWindows`, `PrintWindow`,
`OpenSCManagerW`, `CreateServiceW`, `StartServiceW`, `NtLoadDriver`,
`DeviceIoControl`, `WinExec`, …). Символы, которые уже импортируются
транзитивно и стоят в baseline (`SendInput`, `SetWindowDisplayAffinity`), не
дублируются: новый источник такого импорта — вопрос человеку, а не строка
baseline.

### Чего grep по-прежнему не видит

- COM-hijack, хуки DirectX/OpenGL, Vulkan implicit layers, скрытность в
  сборке и прямое разрешение адресов (`GetProcAddress` → вызов): это ловят
  ревью, `imports.ps1` и живой прогон G7.
- Поведение чужих крейтов: например, `tao` импортирует
  `GetAsyncKeyState`/`GetKeyState` для собственного текстового ввода, а
  prebuilt `libwebrtc` содержит объекты с `OpenThread`/`QueueUserAPC` и
  desktop-capture с `OpenProcess`. Наш код их не вызывает, но в бинарнике
  импорт виден; это записано в отчёте аудита, а не замаскировано.
- Подпись кода: отсутствие Authenticode-подписи нельзя исправить линтером,
  это P0 для публичной беты.


### Что считается нарушением, а что нет

- **Комментарии не считаются использованием.** Строки, начинающиеся с `//`,
  `/*`, `*/` (Rust, TypeScript) и `#` (TOML), пропускаются: `hotkey.rs`
  документирует запрещённые флаги `RIDEV_*` в doc-комментарии, и это не захват
  ввода. Комментарий не может поставить хук.
- **Исключения** — только `tools/anticheat/allowlist.txt` в формате
  `путь:регулярка # ADR NNNN`. Путь — glob, регулярка сверяется со строкой
  кода, запись про ADR обязательна (без неё строка игнорируется). Файл пуст и
  должен остаться пустым: сначала ADR и вопрос человеку, потом исключение.
- **Не проверяется** (и не может быть проверено grep'ом): COM-hijack, хуки
  DirectX/OpenGL, Vulkan implicit layers, прямые syscall'ы, скрытность в
  сборке, поведение чужих крейтов. Это закрывают ревью, `imports.ps1` и живой
  прогон G7.

## `make check-anticheat-imports`

Windows, после `make build-client` (release MSVC):

```powershell
make build-client
make check-anticheat-imports
# то же без make:
powershell -NoProfile -ExecutionPolicy Bypass -File tools/anticheat/imports.ps1
```

`imports.ps1` находит `dumpbin` через `vswhere` (fallback — `dumpbin.exe` в
PATH), снимает `/imports` с `client/src-tauri/target/release/rostalk.exe` (или
с exe из `-ExePath`) и сверяет имена импортов с
`tools/anticheat/forbidden-imports.txt`. С P13 поставляемых exe два:
`make check-anticheat-imports` проверяет и клиент, и установщик сервера
`rostalk-server-setup.exe` (`make build-server-setup`) тем же списком и тем же
baseline; граф зависимостей в `make check-anticheat` строится по всему
workspace (`cargo tree --workspace`).

- Импорт из списка, которого нет в `tools/anticheat/imports-baseline.txt`, —
  ошибка (выход 1).
- Импорт из списка, который в baseline есть, печатается как `baseline` с
  крейтом-источником: это транзитивная зависимость (`tao`, WebView2,
  `libwebrtc`), а не наш код.
- Запись baseline, которой больше нет в бинарнике, печатается как `note`:
  строку пора удалить, но проверка не падает.
- `-List` печатает все импорты по DLL — этим удобно искать источник нового
  символа.

Цель **не входит** в `make check`: ей нужна release-сборка, а хостингового CI
нет — приёмка локальная (`make check`, `make build-client`, живой прогон; см.
ADR 0015). Запускай её перед сдачей этапа, который
меняет ввод, окна, захват или зависимости.

### `DeviceIoControl` и `zip` в апдейтере (этап P13)

После подключения `tauri-plugin-updater` (этап 6.2) release-клиент стал
импортировать `kernel32.dll!DeviceIoControl` — символа не было в baseline. Это
не наш код: плагин по умолчанию включает фичу `zip`, она линкует крейт `zip`,
его распаковка на Windows создаёт символические ссылки через
`std::os::windows::fs::symlink`, а `std` реализует их через `DeviceIoControl`
(`FSCTL_SET_REPARSE_POINT`). Цепочка видна в символах `rostalk_lib.lib`:
`zip::read::extract::make_symlink` → `std::sys::fs::windows::symlink_inner` →
`__imp_DeviceIoControl`.

Вместо строки baseline фича выключена в `client/src-tauri/Cargo.toml`:
`tauri-plugin-updater` собирается с `default-features = false` и
`features = ["rustls-tls", "system-proxy"]`. RosTalk публикует обычный NSIS
`.exe` (`latest.json` → `RosTalk-Setup-<v>.exe`), его плагин ставит и без `zip`;
payload'ы `.exe.zip`/`.msi.zip` не используются. Регрессию ловит
`make check-anticheat-imports`: с `zip` проверка падает с `NEW
kernel32.dll!DeviceIoControl`, без него — EXIT 0. При обновлении
`tauri-plugin-updater` не возвращай `zip` и не добавляй строку baseline:
сначала посмотри этот раздел.

### Baseline: как добавить строку

Baseline — это решение человека, а не кэш. Порядок:

1. Взять символ из отчёта `imports.ps1` (`NEW <DLL>!<Symbol>`).
2. Найти источник: `cargo tree --manifest-path client/src-tauri/Cargo.toml -e
   normal --target x86_64-pc-windows-msvc -i <крейт>` или поиск по
   `~/.cargo/registry/src/**` (`grep -rn "<Symbol>"`).
3. Убедиться, что это чужая транзитивная зависимость, а не наш код. **Чужие
   крейты не патчим.**
4. Добавить строку `<Symbol> # <dll> — <крейт> <версия> (<кто тянет>)` в
   `tools/anticheat/imports-baseline.txt` и объяснить её в отчёте этапа.

Если новый импорт пришёл из нашего кода — это нарушение белого списка: код
убираем, а не baseline правим. Для категорий «Чужие процессы» и «Хуки» любая
строка baseline — отдельный вопрос человеку, даже если формально это
транзитивная зависимость.

## Синтетический ввод в tao (этап 2.3.3a)

`SendInput` остаётся в импортах release-клиента и в baseline: его линкуют
`tao 0.37.3` и `muda 0.20.0`. Чужие крейты не патчим, но из кода RosTalk этот
импорт больше не достижим:

- `tao::set_focus` (`platform_impl/windows/window.rs`) вызывает
  `force_window_active`, а тот при неудаче `SetForegroundWindow` синтезирует
  нажатие и отпускание ALT через `SendInput`. Путь убран: `show_main_window` в
  `client/src-tauri/src/lib.rs` показывает и разворачивает окно, а фокус просит
  своим `SetForegroundWindow` для собственного HWND. Отказ (возврат 0) ничем не
  компенсируется: окно просто остаётся без фокуса.
- `tauri-plugin-window-state` вызывает тот же `set_focus` после `show` при
  восстановлении видимости. Поэтому `StateFlags::VISIBLE` исключён из настроек
  плагина: размер, позиция и maximized восстанавливаются как раньше, видимость —
  нет (окно всегда создаётся видимым по `tauri.conf.json`).
- `muda` использует `SendInput` для команд Edit (copy/paste/select all)
  собственных меню; RosTalk таких пунктов не создаёт (в трее только Show/Quit),
  поэтому путь недостижим.
- Второй вызов `force_window_active` в tao — при создании полноэкранного окна;
  RosTalk полноэкранных окон не создаёт (`tauri.conf.json`).

Регрессию ловит `tools/anticheat/denylist.txt`: правило `\.set_focus\(`.
При обновлении `tao` или `tauri-plugin-window-state` baseline не
перегенерировать молча: перепроверить перечисленные пути и запустить
`make check-anticheat-imports`. Пропавший `SendInput` — повод удалить строку
baseline (`note` в выводе), новый символ — вопрос человеку (порядок выше).

## Полезное

- Проверить вручную: `grep -v '^[[:space:]]*#' tools/anticheat/denylist.txt >
  /tmp/rules && grep -rnE -f /tmp/rules -- client/src-tauri`.
- Ложное срабатывание на своё имя (например, `mouse_events` против
  `mouse_event`) лечится границей слова `\b` в `denylist.txt`, а не
  исключением.
- Правки `denylist.txt` и `allowlist.txt` — такие же изменения правил
  античита, как и код: они идут в отчёт этапа.
