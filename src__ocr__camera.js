// Câmera ao vivo (getUserMedia). Exige HTTPS ou localhost; sem isso, a interface oferece
// "Tirar foto" (aplicativo de câmera do aparelho) e "Galeria".
import { AppError } from './src__core__errors.js';

export function cameraSupport() {
  const hasApi = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const secure = typeof isSecureContext === 'boolean' ? isSecureContext : location.protocol === 'https:';
  if (!hasApi && !secure) return { live: false, reason: 'insecure', message: 'A câmera ao vivo só funciona em endereço seguro (https:// ou localhost). Use "Tirar foto" ou "Galeria".' };
  if (!hasApi) return { live: false, reason: 'unsupported', message: 'Este navegador não oferece acesso à câmera ao vivo. Use "Tirar foto" ou "Galeria".' };
  if (!secure) return { live: false, reason: 'insecure', message: 'A câmera ao vivo só funciona em endereço seguro (https:// ou localhost). Use "Tirar foto" ou "Galeria".' };
  return { live: true, reason: null, message: '' };
}

/** Converte erros do navegador em mensagens compreensíveis. */
export function mapCameraError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return new AppError('CAMERA_DENIED', 'O acesso à câmera foi negado. Permita a câmera nas configurações do navegador (ícone de cadeado ao lado do endereço) ou use "Tirar foto" / "Galeria".', e);
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return new AppError('CAMERA_NOT_FOUND', 'Nenhuma câmera foi encontrada neste aparelho. Use "Galeria" para escolher uma foto.', e);
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return new AppError('CAMERA_BUSY', 'A câmera está em uso por outro aplicativo. Feche-o e tente novamente.', e);
  }
  if (name === 'SecurityError') {
    return new AppError('CAMERA_INSECURE', 'O navegador bloqueou a câmera por segurança. Abra o aplicativo por https:// ou localhost.', e);
  }
  return new AppError('CAMERA_ERROR', 'Não foi possível abrir a câmera.', e);
}

export async function startCamera(video) {
  const support = cameraSupport();
  if (!support.live) throw new AppError('CAMERA_UNAVAILABLE', support.message);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    throw mapCameraError(e);
  }
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  video.muted = true;
  try { await video.play(); } catch (e) { stopCamera(stream, video); throw mapCameraError(e); }
  return stream;
}

export function stopCamera(stream, video) {
  if (stream) for (const t of stream.getTracks()) t.stop();
  if (video) { video.pause?.(); video.srcObject = null; }
}

/** Captura o quadro atual do vídeo em resolução total. */
export function captureFrame(video) {
  const w = video.videoWidth; const h = video.videoHeight;
  if (!w || !h) throw new AppError('CAMERA_NOT_READY', 'A câmera ainda não está pronta. Aguarde um instante e tente de novo.');
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, w, h);
  return c;
}
