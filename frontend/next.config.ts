import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These ship native (.node) or WASM binaries that Turbopack can't place
  // into an ESM chunk — keep them as plain Node `require()`s in the
  // serverless function instead of trying to bundle them.
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist", "tesseract.js"],
};

export default nextConfig;
