# Выбор ASR

Scribe получает PCM16 mono 16 kHz и ожидает текст. Захват, диаризация и хранение
не зависят от конкретной модели. Выбор задаётся в
`plugins.entries.openclaw-scribe.config.asr`. Это настройка владельца Gateway,
не переключатель модели в браузере. Другие аудиофункции OpenClaw не меняются.

## GigaAM Multilingual Large 600M

~~~json
{
  "backend": "gigaam",
  "python": "/absolute/path/to/venv/bin/python",
  "modelDir": "/absolute/path/to/gigaam-models",
  "device": "auto",
  "threads": 6
}
~~~

Нужны Python, FFmpeg и официальный [GigaAM](https://github.com/salute-developers/GigaAM)
с поддержкой `multilingual_large_ctc`; проверен commit
`7447938d791c4f3e643386ee22c33777004293a5`.
Установите runtime в отдельный venv по инструкции GigaAM. На NVIDIA нужна
совместимая с картой сборка PyTorch/CUDA; проверен Torch 2.10.0+cu128.
Например, после установки подходящего Torch:

~~~sh
/absolute/path/to/venv/bin/python -m pip install 'git+https://github.com/salute-developers/GigaAM.git@7447938d791c4f3e643386ee22c33777004293a5'
~~~

В `modelDir` должен уже находиться официальный
[multilingual_large_ctc.ckpt](https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/multilingual_large_ctc.ckpt).
Размер: 2 341 654 513 байт. SHA-256:
`47626500d4d680d0483ad79ba578f1e35ca63cc9d203f06889b1ba76db2a9741`.
Проверяйте происхождение и checksum до загрузки checkpoint; официальный runtime
также проверяет MD5. Код/веса GigaAM — MIT, в TGZ не включены.

Модель загружается лениво на первом аудио, остаётся в памяти между фрагментами
и встречами, завершается при остановке сервиса. Отдельного HTTP-сервера, порта
или облака нет. `device: auto` выбирает CUDA при доступности, иначе CPU; для явного
запрета CPU-fallback задайте `cuda`. На GPU encoder FP16, без Flash Attention.

Официальный short-form API принимает до 25 секунд. Адаптер делит длинные
итоговые реплики на части не более 20 секунд и объединяет текст. Живые
десятисекундные фрагменты проходят без дополнительного деления.
Границы частей могут разрезать слова; это chunked ASR, не cache-aware streaming.
Язык распознаётся моделью, язык встречи не принуждает CTC-декодер.
CTC не восстанавливает пунктуацию/регистр и может передавать английские термины
кириллицей. Дополнительная LLM-коррекция автоматически не включается.

## Другой локальный CLI

~~~json
{ "backend": "openclaw" }
~~~

Это также поведение без `asr`. Используются только локальные аудио-CLI из
`tools.media.models` с их аргументами и тайм-аутами. Например, whisper.cpp.
Облачные провайдеры исключаются, скрытого fallback нет.
Каждый фрагмент вызывает CLI заново: это неэффективно при тяжёлой загрузке весов.

## Другой резидентный движок

~~~json
{
  "backend": "worker",
  "command": "/absolute/path/to/interpreter",
  "args": ["/absolute/path/to/adapter"],
  "maxChunkSeconds": 20,
  "startupTimeoutSeconds": 120,
  "timeoutSeconds": 120
}
~~~

Это универсальный адаптер для локального движка, а не загрузчик произвольного
checkpoint без соответствующего runtime. Команда запускается без shell, один раз
при первом запросе. Только JSONL в stdout; диагностика в stderr поглощается без
записи аудио/текста в журналы Gateway.

После загрузки движок печатает одну строку:

~~~json
{"type":"ready","maxSeconds":25}
~~~

`maxSeconds` должен быть не меньше `maxChunkSeconds` (0.2–30 секунд).
На каждую строку stdin:

~~~json
{"id":1,"filePath":"/private/temporary/audio.wav","language":"ru"}
~~~

ровно один ответ stdout с тем же числовым `id`:

~~~json
{"id":1,"text":"распознанный текст"}
~~~

Либо `{"id":1,"error":"краткая причина ошибки"}`. Пустой текст допустим.
Запросы сериализованы; готовность ограничена startup timeout, каждый запрос —
inference timeout. Буфер ответа не более 128 KiB.
Падение, timeout или некорректный протокол явно прерывают запрос, без смены модели;
после завершения процесса следующая запись может запустить новый. После смены
настроек выполните `openclaw plugins reload openclaw-scribe` либо перезапустите
Gateway. Готовый адаптер:
[src/plugin/gigaam-worker.py](https://github.com/Efreh/openclaw-scribe/blob/main/src/plugin/gigaam-worker.py).

WAV удаляется после ответа/ошибки. Полная временная запись при диаризации и
восстановление после ошибок описаны в README. Worker не должен сохранять свою
копию аудио.
