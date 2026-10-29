# Проверка 0.3.0

Изменение: конфигурируемый локальный ASR, резидентный адаптер GigaAM
Multilingual Large 600M CTC и общий JSONL-контракт внешнего процесса.
Протокол расширения и Nemotron-диаризатор не менялись.

Проверено:

- TypeScript check и 16 unit/integration-тестов, включая reuse процесса,
  деление 30-секундной реплики на 20+10, другой CLI без GigaAM, crash,
  неверный протокол, inference error, startup/inference timeout и cleanup.
- Установка настоящего TGZ в отдельный временный профиль OpenClaw 2026.10.7;
  команда pair возвращает полный постоянный токен без записи в журнал.
- Настоящие GigaAM, PyTorch/CUDA и публичный русский 10-секундный пример
  Podlodka: полный WS → ASR → native transcript → summary.
- Настоящие GigaAM + Nemotron на публичном двухголосном 30-секундном
  примере pyannote: 3 live chunks, 11 финальных реплик, оба голоса и
  пересечение; без fallback к черновику.
- Сохранение старой глобальной audio-конфигурации при отдельной настройке
  Scribe ASR. Ни один автоматический тест не изменяет рабочий Gateway.

В TGZ входят JSON-schema настроек, worker и инструкция docs/asr.md.
Python, PyTorch и веса в архив не включены, модели не скачиваются при записи.
Смена ASR не требует обновления браузерного расширения с протоколом v1.
Браузерный код в этом изменении не менялся; аппаратные проверки выше не
означают повторный прогон всех браузерных сценариев.

Это проверка интеграции, не новый benchmark качества или гарантия любых
задержек. При первой записи есть загрузка весов; CTC не добавляет пунктуацию.
Сами публичные записи, результаты, окружение и host-specific paths в Git
не включены. Методика запуска изолированного профиля:

~~~sh
npm run test:native -- --audio /path/to/public.wav --language ru --duration 10 --asr-config /path/to/asr.json
npm run test:native -- --audio /path/to/two-speakers.wav --language en --duration 30 --diarization --asr-config /path/to/asr.json
~~~

asr.json содержит только объект настройки ASR из docs/asr.md, без токенов.
