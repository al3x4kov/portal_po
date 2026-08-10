@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Защита от запуска прямо из окна ZIP-архива: проводник Windows распаковывает
rem во временную папку только сам start.cmd, без остальных файлов репозитория,
rem и npm подхватывает чужой package.json выше по дереву — Missing script: "build".
if not exist "%~dp0package.json" (
  echo Ошибка: рядом со start.cmd нет package.json проекта.
  echo Текущая папка: %CD%
  echo.
  echo Похоже, скрипт запущен прямо из окна ZIP-архива или из неполной распаковки.
  echo Что сделать:
  echo   1. Кликните по скачанному ZIP правой кнопкой и выберите «Извлечь всё...»
  echo   2. Запустите start.cmd из распакованной папки с проектом
  echo Либо клонируйте репозиторий: git clone и запустите start.cmd из его корня.
  pause
  exit /b 1
)

rem Портал требует Node.js >= 20 (см. package.json engines / CLAUDE.md).
where node >nul 2>nul
if errorlevel 1 (
  echo Ошибка: Node.js не найден. Установите Node.js 20 или новее: https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%v in ('node --version') do set NODE_MAJOR=%%v
if %NODE_MAJOR% lss 20 (
  echo Ошибка: требуется Node.js ^>= 20, у вас установлена более старая версия:
  node --version
  echo Обновите Node.js: https://nodejs.org
  pause
  exit /b 1
)

echo [1/3] Установка зависимостей: npm install...
if not exist node_modules (
  echo     Первый запуск: npm скачает ~0.5 ГБ зависимостей — это может занять несколько минут.
)
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo Ошибка: npm install завершился с ошибкой — см. вывод выше.
  pause
  exit /b 1
)
echo     Зависимости установлены.

echo [2/3] Сборка: core + server + web...
call npm run build
if errorlevel 1 (
  echo Ошибка: сборка завершилась с ошибкой — см. вывод выше.
  pause
  exit /b 1
)

if not defined PORT set PORT=3000
echo [3/3] Запуск сервера: http://127.0.0.1:%PORT%
node apps\server\dist\main.js
pause
