import * as tls from "node:tls";

type SystemCaTls = typeof tls & {
  getCACertificates?: (type?: "default" | "system") => string[];
  setDefaultCACertificates?: (certificates: string[]) => void;
};

export function enableWindowsSystemCertificates() {
  if (process.platform !== "win32") return false;
  const runtime = tls as SystemCaTls;
  if (typeof runtime.getCACertificates !== "function" || typeof runtime.setDefaultCACertificates !== "function") return false;
  const certificates = [...new Set([
    ...runtime.getCACertificates("default"),
    ...runtime.getCACertificates("system")
  ])];
  if (certificates.length === 0) return false;
  runtime.setDefaultCACertificates(certificates);
  return true;
}
