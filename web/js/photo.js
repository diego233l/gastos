// Reduce la imagen en el navegador: máx. 900 px, JPEG. El servidor vuelve a validarla.
const MAX_SIDE = 900;
const MAX_BYTES = 650_000;

async function decode(file) {
  try {
    return await createImageBitmap(file);
  } catch (err) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen.")); };
      img.src = url;
    });
  }
}

export async function shrinkImage(file) {
  if (!file.type || !file.type.startsWith("image/")) throw new Error("El archivo elegido no es una imagen.");
  if (file.size > 30 * 1024 * 1024) throw new Error("La imagen es demasiado grande (máx. 30 MB).");
  const img = await decode(file);
  const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
  if (!w0 || !h0) throw new Error("La imagen no tiene dimensiones válidas.");
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * scale)), height = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // los PNG transparentes quedan sobre blanco
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  if (img.close) img.close();
  let blob = null;
  for (const q of [0.86, 0.72, 0.58, 0.45]) {
    blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= MAX_BYTES) break;
  }
  if (!blob) throw new Error("No se pudo procesar la imagen.");
  if (blob.size > MAX_BYTES) throw new Error("La imagen sigue siendo demasiado pesada tras reducirla.");
  return { blob, width, height };
}
