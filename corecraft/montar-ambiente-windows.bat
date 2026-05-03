@echo off
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1

if /I "%~1"=="--todas-atividades" (
  echo == Nota: --todas-atividades ja nao e necessario; este script sobe sempre todas as stacks.
)

echo == Infra partilhada (bitcoind + caddy)
docker compose up -d
if errorlevel 1 exit /b 1

echo == atividade-1
pushd atividade-1
call docker compose up -d --build
if errorlevel 1 exit /b 1
popd

echo == atividade-2
pushd atividade-2
call docker compose up -d --build
if errorlevel 1 exit /b 1
popd

echo == atividade-3
pushd atividade-3
call docker compose up -d --build
if errorlevel 1 exit /b 1
popd

echo.
echo Pronto: infra + atividades 1-3.
exit /b 0
