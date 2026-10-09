// Cliente de la API: añade la cabecera anti-CSRF y convierte cualquier fallo en un mensaje claro.
export class ApiError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors || {};
  }
}

async function request(method, path, { json, body, contentType } = {}) {
  const headers = { "X-Requested-With": "gastos" };
  let payload;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(json);
  } else if (body !== undefined) {
    headers["Content-Type"] = contentType;
    payload = body;
  }
  let res;
  try {
    res = await fetch("api" + path, { method, headers, body: payload, credentials: "same-origin" });
  } catch (err) {
    throw new ApiError("No se pudo conectar con el servidor. Comprueba tu conexión.", 0);
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
  if (!res.ok) {
    const msg = (data && data.error) ||
      (res.status === 401 ? "Sesión no válida: recarga la página e introduce la contraseña."
        : `El servidor respondió con un error ${res.status}.`);
    throw new ApiError(msg, res.status, data && data.errors);
  }
  if (data === null && res.status !== 204) {
    throw new ApiError("La respuesta del servidor no es válida.", res.status);
  }
  return data;
}

export const api = {
  get: (p) => request("GET", p),
  post: (p, json) => request("POST", p, { json: json ?? {} }),
  put: (p, json) => request("PUT", p, { json }),
  del: (p) => request("DELETE", p),
  putImage: (p, blob) => request("PUT", p, { body: blob, contentType: blob.type }),
};
