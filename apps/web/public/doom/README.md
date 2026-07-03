# DOOM (полностью офлайн, локальный запуск)

Играбельная классическая DOOM, встроенная в портал и запускаемая целиком с локального
Node-сервера. В рантайме **нет обращений во внешнюю сеть** — все ассеты вендорены в этот
каталог и грузятся по относительным путям (`/doom/...`).

Открывается по адресу `/doom/` (сервер отдаёт `apps/web/dist/doom/` статикой).

## Что здесь лежит

| Файл          | Размер  | Что это                                                              |
| ------------- | ------- | ------------------------------------------------------------------- |
| `index.html`  | ~5 КБ   | Самодостаточный загрузчик (canvas + клавиатура), пути относительные. |
| `doom1.js`    | ~330 КБ | Emscripten-glue движка **PrBoom** (SDL, одно-поточный).              |
| `doom1.wasm`  | ~1.0 МБ | WebAssembly-сборка движка PrBoom.                                    |
| `doom1.data`  | ~4.5 МБ | Emscripten-пакет с двумя WAD: `prboom.wad` + `doom1.wad`.            |

Итого ~5.6 МБ. **SharedArrayBuffer не используется**, поэтому заголовки
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` (COOP/COEP) **не требуются**.

## Движок

**PrBoom** (порт DOOM, GPLv2), скомпилированный в WebAssembly через Emscripten.
Предсобранные статические файлы (`doom1.js`, `doom1.wasm` и исходный ассет-пакет) взяты из
проекта **webDOOM** — <https://github.com/UstymUkhman/webDOOM> (обёртка под лицензией MIT
поверх GPLv2-движка PrBoom).

Оригинальный `doom1.data` из webDOOM весит ~96 МБ, потому что дополнительно содержит
опциональные HQ-музыку (MP3) и SFX (WAV). Здесь пакет пересобран так, чтобы содержать
только два WAD (`prboom.wad` + `doom1.wad`) — движок PrBoom при отсутствии внешних MP3
корректно откатывается на встроенную в WAD MIDI-музыку. Метаданные `loadPackage(...)` в
`doom1.js` соответственно урезаны до этих двух файлов.

## Ассеты и лицензии

- **`doom1.wad`** — **shareware**-версия DOOM (IWAD, 4 196 020 байт, DOOM shareware v1.9,
  md5 `5f4eb849b1af12887dec04a2a12e5e62`). id Software официально разрешила свободное
  распространение shareware-эпизода «Knee-Deep in the Dead». Магия файла — `IWAD`.
  Это **не** полная/коммерческая версия (registered DOOM ~10 МБ, DOOM II ~14 МБ).
- **`prboom.wad`** — свободный вспомогательный lump движка PrBoom (PWAD, GPLv2).
- **`doom1.js` / `doom1.wasm`** — движок PrBoom (GPLv2), сборка из webDOOM (MIT-обёртка).

## Источники (скачано и завендорено, в рантайме не запрашивается)

- Движок (js/wasm/исходный data): <https://github.com/UstymUkhman/webDOOM>
  (`public/doom1.js`, `public/doom1.wasm`, `public/doom1.data`).
- Shareware IWAD как таковой также свободно доступен, напр.:
  <https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad>.

DOOM © id Software. Здесь используется только свободно распространяемый shareware-контент.
