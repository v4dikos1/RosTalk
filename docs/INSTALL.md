# Установка RosTalk

Все файлы — на странице релизов GitHub:
**https://github.com/v4dikos1/RosTalk/releases/latest** (репозиторий релизов —
переменная `RELEASE_REPO` у `make release`, ADR 0026). Клиент и сервер
поставляются раздельно.

## Хочу подключиться

Нужен только клиент для Windows 10/11 и ссылка-приглашение от владельца
сервера.

1. Скачайте `RosTalk-Setup-<версия>.exe` и запустите. Установка идёт в профиль
   пользователя, без прав администратора и без UAC; ссылки `rostalk://` начинают
   открывать клиент. Без установки — `RosTalk-<версия>-portable.zip`:
   распакуйте и запустите `rostalk.exe`.
2. Откройте ссылку-приглашение (или нажмите «Подключиться» и вставьте её).
3. Обновления приходят из клиента: «Настройки → Обновления → Проверить
   обновления». Источник по умолчанию — `latest.json` последнего релиза;
   пакет проверяется подписью до запуска (ADR 0019).

Сборки пока без подписи Authenticode: SmartScreen покажет «Windows защитила
ваш компьютер» → «Подробнее» → «Выполнить в любом случае». Сверить файл можно
по `SHA256SUMS` релиза (`Get-FileHash RosTalk-Setup-<версия>.exe`).

## Хочу свой сервер

Сервер работает только на Linux (VPS или домашняя машина). Из клиента сервер
больше не ставится: в нём есть пункт «Хочу свой сервер» с адресом этой
страницы и кнопкой «Копировать» (браузер клиент не открывает, ADR 0023).

- **С Windows-компьютера:** скачайте `RosTalk-Server-Setup-<версия>.zip`,
  распакуйте целиком и запустите `rostalk-server-setup.exe`. Программа ставит
  сервер на VPS по SSH и выдаёт ссылку-приглашение (раздел
  «Установка с Windows» ниже).
- **Прямо на Linux-сервере** — одна команда (раздел 1):

  ```sh
  curl -fsSL https://github.com/v4dikos1/RosTalk/releases/latest/download/install.sh | sudo sh
  ```

Ниже — подробности. Выберите один путь: VPS, Docker или домашняя
Linux-машина.

Открытые порты (все три нужны и на файрволе, и в панели провайдера):

| Порт | Зачем |
|---|---|
| TCP 7443 | HTTPS/WSS: управление, сигналинг, файлы |
| TCP 7881 | запасной путь медиа, если у клиента закрыт UDP |
| UDP 7882 | голос и стримы |

Данные сервера (база, ключи, сертификат) лежат в каталоге данных: `/var/lib/rostalk`
у install.sh, том `rostalk-data` у Docker. Без этого каталога сервер теряет
пользователей, каналы и ссылки, поэтому его и только его нужно бэкапить.

### UDP-буфер ядра

LiveKit просит у ядра 16 МиБ на приём UDP, но практический минимум для
нескольких сотен потоков — 5 МиБ. Многие дистрибутивы оставляют
`net.core.rmem_max` по умолчанию (212992 байта, после удвоения 425984). При
нескольких сотнях потоков буфер переполняется, и сервер пишет предупреждение
`failed to sufficiently increase receive buffer size`. `rostalk-server doctor`
теперь показывает это отдельной строкой (предупреждение, не ошибка) и ничего не
меняет; поднимите лимит сами:

```sh
sudo sysctl -w net.core.rmem_max=5242880
echo 'net.core.rmem_max=5242880' | sudo tee /etc/sysctl.d/99-rostalk.conf
```

На VPS это уже сделано; в Docker значение берётся с хоста, поэтому меняйте его на
хосте, а не внутри контейнера.

Первый запуск печатает одноразовую админ-ссылку: кто её открыл, тот стал
администратором. Дальше приглашения создаются командой `rostalk-server invite`
или из клиента.

---

## 1. VPS: одна команда

Нужны Linux x86_64/aarch64 и одна из поддерживаемых систем: Ubuntu 22.04+,
Debian 12+, Fedora 38+, AlmaLinux/Rocky/RHEL/Oracle Linux 8+ или CentOS
Stream 9+, root и OpenSSL 3 (для проверки подписи). Можно сразу указать
`--domain` — тогда сертификат Let's Encrypt выпустится сам (DNS A-запись
должна уже смотреть на VPS, порты 80/443 должны быть открыты).

Из последнего релиза на GitHub:

```sh
curl -fsSL https://github.com/v4dikos1/RosTalk/releases/latest/download/install.sh | sudo sh -s -- \
    --public-host 203.0.113.5
```

Без `--base-url` скрипт берёт файлы из релиза репозитория, который вшит в
опубликованный `install.sh` (`--repo owner/name` меняет его, `--version 1.2.3`
берёт конкретный релиз вместо последнего). Доверие держится на подписи, а не
на хосте: `SHA256SUMS` проверяется ключом `deploy/release.pub`, вшитым в
скрипт, затем SHA-256 бинарника. Свой каталог с релизом по HTTPS тоже
работает:

```sh
curl -fsSL https://example.net/rostalk/install.sh | sudo sh -s -- \
    --base-url https://example.net/rostalk \
    --public-host 203.0.113.5
```

Скрипт проверяет подпись `SHA256SUMS`, ставит бинарник в `/usr/local/bin`,
создаёт пользователя `rostalk` и systemd-юнит, включает и запускает сервис,
печатает правила файрвола и админ-ссылку. Повторный запуск с новой версией —
это обновление: данные не трогаются.

С доменом:

```sh
curl -fsSL https://example.net/rostalk/install.sh | sudo sh -s -- \
    --base-url https://example.net/rostalk --domain rostalk.example.com
```

Дальше:

```sh
sudo rostalk-server doctor --data /var/lib/rostalk     # порты, внешний IP, роутер
sudo rostalk-server invite --data /var/lib/rostalk --public-host 203.0.113.5
sudo rostalk-server backup --data /var/lib/rostalk --out /root/rostalk.tar.gz
sudo rostalk-server update --release-url https://github.com/v4dikos1/RosTalk/releases/latest/download --restart
```

`doctor` ничего не меняет: он печатает, что открыть и куда смотреть.

---

## 2. Docker

Нужен Docker Engine и compose. Образ — Alpine, непривилегированный пользователь,
том `/data`, healthcheck. Порты публикуются через `-p`; `--network host` не
используется (в Docker Desktop он ломает медиа, ADR 0001).

```sh
git clone https://github.com/v4dikos1/RosTalk
cd RosTalk
cp deploy/docker/.env.example deploy/docker/.env
# в .env: ROSTALK_PUBLIC_HOST и ROSTALK_ADVERTISE_IP = публичный IP (или LAN IP дома)
docker compose -f deploy/docker/compose.yaml up -d --build
docker compose -f deploy/docker/compose.yaml logs server   # админ-ссылка
```

Без compose, тот же образ:

```sh
docker build -f deploy/docker/Dockerfile -t rostalk-server .
docker run -d --name rostalk -p 7443:7443 -p 7881:7881 -p 7882:7882/udp \
  -v rostalk-data:/data -e ROSTALK_PUBLIC_HOST=203.0.113.5 \
  rostalk-server run --data=/data --public-host=203.0.113.5 --advertise-ip=203.0.113.5
docker logs rostalk
```

Домен: добавьте в `command` `--domain=rostalk.example.com`, `--acme-http-addr=:8080`
и `--acme-tls-addr=:8443` (образ работает не от root, поэтому внутри контейнера
ACME слушает высокие порты), опубликуйте `80:8080` и `443:8443` и задайте
`ROSTALK_DOMAIN`. Внутри контейнера `--nat` бесполезен: проброс делает Docker или
роутер.

---

## 3. Домашняя Linux-машина

Если роутер умеет UPnP или NAT-PMP, сервер попробует пробросить порты сам:

```sh
curl -fsSL https://example.net/rostalk/install.sh | sudo sh -s -- \
    --base-url https://example.net/rostalk --nat auto
```

`--nat auto` сначала пробует UPnP, потом NAT-PMP. Если роутер отказал, сервис
всё равно запустится; `sudo rostalk-server doctor` покажет, включён ли проброс,
какой внешний IP видит сеть (STUN) и что открыть руками:

- TCP 7443 и 7881, UDP 7882 → на LAN-адрес машины;
- если провайдер даёт «серый» IP (CGNAT), проброс не поможет: нужен VPS или
  публичный IP у провайдера.

Клиенты вне дома подключаются по публичному IP или DDNS-имени: передайте его в
`--public-host` при установке или в `ROSTALK_PUBLIC_HOST` в юните.

---

## Установка с Windows: RosTalk Server Setup

`RosTalk-Server-Setup-<версия>.zip` — отдельная программа
`rostalk-server-setup.exe` и папка `server/` с подписанным релизом сервера той
же версии (ADR 0026; до P13 это был мастер «Свой хостинг» внутри клиента,
ADR 0021). Распакуйте архив целиком: без `server/` установка не начнётся.
Программа ничего не ставит на Windows и не просит прав администратора.
Мастер из четырёх шагов:

1. адрес VPS, SSH-порт, пользователь, ключ или пароль, отпечаток host key;
2. проверка системы и настройки: имя сервера, домен, режим входа, лимит,
   публичный адрес, галочка «открыть порты»;
3. установка с пошаговым журналом и отменой;
4. готово: админ-ссылка и ссылка для друзей с кнопками «Копировать» и памятка
   про облачный файрвол. Админ-ссылку вставьте в клиенте в «Подключиться».

Программа ставит сервер по SSH только после успешной проверки: Linux x86_64 или
aarch64, Ubuntu 22.04+, Debian 12+, Fedora 38+, AlmaLinux/Rocky/RHEL/Oracle
Linux 8+ (или CentOS Stream 9+), systemd, `tar`, `sha256sum`, `openssl`,
свободное место и свободные порты. Host key проверяется по TOFU,
отпечаток сохраняется в `ssh_known_hosts.json` в каталоге приложения; при
несовпадении установка останавливается. Пароли живут только в памяти (оплата —
галочка «запомнить» кладёт их в Windows Credential Manager).

На OpenSSL 1.1.1 (AlmaLinux 8, часть Debian 11) `openssl pkeyutl` не умеет
`-rawin`. Клиент проверяет Ed25519-подпись `SHA256SUMS` встроенным
`deploy/release.pub` до отправки; `install.sh` в этом случае проверяет SHA-256 и
печатает явное предупреждение. Мастер показывает это на шаге проверки. Для
ручной установки `curl|sh` на OpenSSL 1.1.1 нужен OpenSSL 3.x: флаг
`--preverified-signature` выставляет только клиент после своей проверки.

На RHEL-семействе (AlmaLinux, Rocky, RHEL, Oracle Linux, CentOS Stream) мастер
при необходимости ставит через `dnf` только `openssl`, `ca-certificates`, `tar`
и `iproute`; `sha256sum` входит в `coreutils`.

Релиз сервера едет вместе с установщиком; `make release` собирает архив сам.
Для разработки:

```sh
ROSTALK_SIGN_KEY=%USERPROFILE%/.rostalk/release/rostalk-release.key make server-bundle
make build-server-setup     # client/src-tauri/target/release/rostalk-server-setup.exe
```

`make server-bundle` собирает linux/amd64 и linux/arm64, подписывает
`SHA256SUMS` и кладёт файлы в `client/src-tauri/resources/server` (каталог не
коммитится). В dev-сборке путь можно задать через `ROSTALK_SERVER_BUNDLE`.
Программа ищет `resource_dir()/server`, затем `<каталог exe>/server`.
Интеграционный тест по SSH — `make test-client-install-docker`.

Порты по умолчанию клиент **не** открывает: он показывает точные команды
`ufw`/`firewalld`. Галочка «открыть порты» добавляет ровно 7443/tcp, 7881/tcp и
7882/udp на удалённой машине. Если файрвол не установлен или не активен,
установка не прерывается: мастер показывает команды и предупреждение. Файрвол
облака (Hetzner, OVH и т. п.) нужно открыть в панели провайдера, а локальный
файрвол Windows программа не трогает никогда.

Если RosTalk уже установлен, мастер предлагает «Обновить» или «Переустановить».
Перед переустановкой выполняется `rostalk-server backup` в
`/var/backups/rostalk`, каталог `/var/lib/rostalk` не удаляется. Предыдущий
бинарник и юнит сохраняются как `.bak`; если служба не поднялась или `/healthz`
не отвечает, программа возвращает `.bak`, перезапускает службу и показывает
`journalctl -u rostalk-server -n 50`.

## Переход с Hearth

До версии 0.3.0 проект назывался Hearth (ADR 0033). Старые установки
переносятся без потери личности, пользователей и каналов.

**Клиент.** Поставьте RosTalk (`RosTalk-Setup-<версия>.exe`) и запустите один
раз: личность из Credential Manager и список серверов скопируются из старого
клиента сами. После этого Hearth можно удалить; данные RosTalk от этого не
зависят. Старый клиент сам не обновится: его апдейтер смотрел в приватный
репозиторий. Ссылки `hearth://join?...` по-прежнему принимаются в окне
подключения.

**Сервер.** Обновите сервер той же командой, что и при установке:

```sh
curl -fsSL https://github.com/v4dikos1/RosTalk/releases/latest/download/install.sh | sudo sh
```

`install.sh` найдёт `/var/lib/hearth`, остановит и выключит `hearth-server`,
перенесёт данные в `/var/lib/rostalk`, отдаст их пользователю `rostalk` и
запустит `rostalk-server`. Файл базы `hearth.db` сервер переименует сам при
старте. Старые бинарник и юнит остаются рядом как `*.hearth-old`, ссылки и
отпечаток TLS не меняются. Переменные окружения `HEARTH_*` ещё читаются, но в
логе будет предупреждение: переименуйте их в `ROSTALK_*`. Мастер «RosTalk
Server Setup» на сервере со старой установкой останавливается и просит
сначала выполнить эту команду.

Параметры старой службы из `ExecStart` переносятся в новый юнит: `--domain`,
`--listen`, `--public-host`, `--advertise-ip`, `--nat` и `--log-file` (путь
внутри каталога данных переписывается на `/var/lib/rostalk`). Тот же набор
читается из действующего юнита RosTalk при повторной установке, поэтому
повторная команда не сбрасывает домен, порт и адрес медиа. Явно переданные
установщику параметры важнее старых, поэтому изменить порт или адрес медиа при
обновлении можно той же командой, например
`... | sudo sh -s -- --listen=:9443 --advertise-ip=203.0.113.7`. Если в старом
юните есть незнакомый параметр, установщик останавливается до остановки службы
и переноса данных и показывает, какие параметры передать вручную. Повторный
запуск после сбоя безопасен: установщик либо возвращает рабочую установку
Hearth, либо доводит перенос до конца, включая права на ключи `0600`. При
откате владелец и группа берутся из старого юнита (`User=`/`Group=`), поэтому
установка с нестандартным `--user` тоже возвращается рабочей; если вернуть
владельца не удалось, установщик печатает ошибку `chown` и оставляет данные в
`/var/lib/hearth` для повторного запуска.

## Логи и метрики

Установщик добавляет `--log-file=/var/lib/rostalk/logs/rostalk-server.log`:
файл ротируется по размеру (10 МиБ, 5 файлов), текущая строка не теряется, а
systemd по-прежнему пишет ту же строку в journal. Отключить файл:
`--log-file=` (только journal). Порог и число файлов меняются флагами
`--log-max-size` и `--log-keep`.

Prometheus слушает только `127.0.0.1:9090` (`--metrics-addr`, `off`
выключает). На сервере:

```sh
curl -s http://127.0.0.1:9090/metrics | grep '^rostalk_'
```

Там `rostalk_online_users`, `rostalk_channels`, `rostalk_media_rooms`,
`rostalk_media_participants`, `rostalk_media_tracks`, `rostalk_build_info`, а также
коллекторы LiveKit и стандартные `process_*`/`go_*`. Порт не публикуется
наружу; не добавляйте его в firewall и не проксируйте.

Полный тест мастера против одноразового sshd-контейнера:

```sh
make server-bundle
make test-client-install-docker
```

Он проверяет пароль и ключ, sudo, TOFU, чужой host key, занятый порт, установку,
`/healthz`, вход клиента по админ-ссылке и повторную установку без потери базы.


---

## Подпись релизов и обновление

Релиз собирается `ROSTALK_SIGN_KEY=/путь/к/ключу sh deploy/release.sh` (Linux или
контейнер `golang:1.27`) в `dist/`: два бинарника linux/amd64 и linux/arm64,
`install.sh`, `release.pub`, `SHA256SUMS` и `SHA256SUMS.sig` (Ed25519 по файлу
`SHA256SUMS`). Приватный ключ создаётся один раз:

```sh
cd server && go run ./cmd/rostalk-sign keygen --out /secure/rostalk-release.key
go run ./cmd/rostalk-sign pubkey --key /secure/rostalk-release.key
```

Приватный ключ не коммитится и не копируется на сервер. Публичная часть —
`deploy/release.pub`, она же вшита в `install.sh` и в каждый релизный бинарник:
```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA8Dp673Q0lj2oVoVWU/ZtYNOlnqMSPq8ETppbc7tasbc=
-----END PUBLIC KEY-----
fingerprint: beff7704aba5a4621414e2bb8b162d4bb3590c7b46e9892b73f7758f760ac2cd
```

`rostalk-server version` печатает этот ключ и отпечаток; `rostalk-server update`
принимает только релиз, подпись которого сходится с ним (или с `--pubkey`).

Если бинарник собран локально, установить его можно без релизного сервера:
`sudo sh deploy/install.sh --from-file dist/rostalk-server_<версия>_linux_amd64
--sums dist/SHA256SUMS`. Проверка самого установщика в чистых контейнерах —
`sh deploy/test-install-docker.sh` (нужен собранный `dist/`).

Бэкап — один архив: база (согласованный снимок SQLite), ключи TLS, состояние
ACME, настройки и файлы. Восстановление в пустой каталог возвращает
пользователей, каналы и роли; `--force` заменяет непустой каталог и оставляет
старый рядом как `<данные>.pre-restore-<время>`. Перед восстановлением остановите
сервис. Архив содержит ключи — храните его как пароль.

```sh
sudo rostalk-server backup --data /var/lib/rostalk --out /root/rostalk.tar.gz
sudo systemctl stop rostalk-server
sudo rostalk-server restore --archive /root/rostalk.tar.gz --data /var/lib/rostalk
sudo systemctl start rostalk-server
```

На свежей машине, где каталога данных ещё нет, добавьте
`--owner rostalk:rostalk`: иначе восстановленные файлы останутся за root и сервис
не сможет их прочитать. Если каталог уже существует, владелец сохраняется сам.

---

## Для владельца: выпуск релиза

Полный порядок — `docs/RELEASE.md`; что где лежит и почему — ADR 0026. Коротко:

```powershell
make check
make release VERSION=0.2.0                       # dist/release-0.2.0
make publish-release VERSION=0.2.0 DRY_RUN=1     # что будет отправлено
git tag -a v0.2.0 -m "RosTalk 0.2.0"; git push origin v0.2.0
make publish-release VERSION=0.2.0               # gh release create, ваш gh-логин
```

Состав релиза: `RosTalk-Setup-<v>.exe`, `RosTalk-<v>-portable.zip`,
`RosTalk-Server-Setup-<v>.zip`, `rostalk-server_<v>_linux_amd64`,
`rostalk-server_<v>_linux_arm64`, `install.sh`, `latest.json`, `SHA256SUMS`,
`SHA256SUMS.sig`. `SHA256SUMS` покрывает все файлы и подписан ключом релиза
Ed25519; публикуйте его вместе с релизом всегда.

### Подпись Authenticode (необязательно, сертификата пока нет)

`make release` подписывает `rostalk.exe`, установщик NSIS (exe внутри portable —
тот же `rostalk.exe`) и `rostalk-server-setup.exe`, если подпись настроена, иначе
пишет «НЕ ПОДПИСАНО» и продолжает. SHA-256, метка времени RFC 3161. Настройка —
только переменные окружения или локальный файл
`%USERPROFILE%\.rostalk\release\signing.env` (вне репозитория; путь меняет
`ROSTALK_SIGNING_ENV`):

```sh
# сертификат в хранилище Windows (токен или облачный HSM через CSP/KSP)
ROSTALK_AUTHENTICODE_THUMBPRINT=<SHA-1 сертификата>
ROSTALK_AUTHENTICODE_TIMESTAMP_URL=<RFC 3161 URL удостоверяющего центра>
# или своя команда, %1 — подписываемый файл (Tauri делит её по пробелам)
ROSTALK_AUTHENTICODE_COMMAND=<команда ... %1>
```

Механизм штатный для Tauri 2.12: `bundle.windows.certificateThumbprint`,
`digestAlgorithm`, `timestampUrl`, `tsp` или `signCommand` передаются в
`tauri build --config` только на время сборки. `rostalk-server-setup.exe`
собирается без бандлера, его подписывает тот же `signtool` или та же команда.
После сборки подпись всех трёх файлов проверяется `signtool verify /pa`.

Где взять сертификат — решает владелец (CI без решения в проект не
добавляется, ADR 0015):

1. **SignPath Foundation** — бесплатно для open source. Условия: OSI-лицензия
   в репозитории, сборка на GitHub Actions (отступление от ADR 0015, нужно
   отдельное решение и ADR), издателем в подписи будет «SignPath Foundation»,
   а не RosTalk.
2. **OV-сертификат удостоверяющего центра** (Sectigo, DigiCert, SSL.com и
   т. п.) на аппаратном токене или в облачном HSM + `signtool`
   (`ROSTALK_AUTHENTICODE_THUMBPRINT` и `…_TIMESTAMP_URL`, для облачного HSM —
   `ROSTALK_AUTHENTICODE_COMMAND`). Платно, нужна проверка личности или
   организации; репутация SmartScreen набирается со временем.
3. **Microsoft Artifact Signing** (бывший Trusted Signing) — подпись через
   `ROSTALK_AUTHENTICODE_COMMAND`; частным лицам доступен только в США и
   Канаде.

Authenticode остаётся открытым P0 до публичной беты.

### Ручные шаги перед публикацией

- Проверить `RosTalk-Setup-<v>.exe`, оба zip, `rostalk.exe` и
  `rostalk-server-setup.exe` на VirusTotal.
- При ложных срабатываниях отправить файлы в Microsoft Security Intelligence
  (https://www.microsoft.com/wdsi/filesubmission, «Submit a file» →
  «Software developer») и вендорам антивирусов, которые ругаются.
- Опубликовать `SHA256SUMS` и `SHA256SUMS.sig` рядом с релизом (их загружает
  `make publish-release`).
