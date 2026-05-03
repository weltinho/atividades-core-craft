@echo off
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1

echo == Infra partilhada (bitcoind + caddy)
docker compose up -d
if errorlevel 1 exit /b 1

if /I "%~1"=="--todas-atividades" (
  echo == atividade-1
  pushd atividade-1
  call docker compose up -d --build
  popd
  echo == atividade-2
  pushd atividade-2
  call docker compose up -d --build
  popd
  echo == atividade-3
  pushd atividade-3
  call docker compose up -d --build
  popd
  echo.
  echo Pronto: infra + atividades 1-3.
) else (
  echo.
  echo Infra no ar. Para subir tambem as stacks: %~nx0 --todas-atividades
  echo Ou manualmente: cd atividade-n ^&^& docker compose up -d --build
)
exit /b 0
