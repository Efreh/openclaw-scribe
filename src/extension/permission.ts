document.getElementById("allow")!.onclick = async () => {
  const result = document.getElementById("result")!;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    result.textContent = "Доступ разрешён. Закройте эту вкладку, откройте нужную встречу и нажмите значок Scribe.";
  } catch { result.textContent = "Микрофон недоступен. Проверьте разрешения браузера и выбранное устройство."; }
};
