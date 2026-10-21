// Extracts plain text from an uploaded resume file (PDF, Word .docx, or plain text).

import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"];

export class ResumeParseError extends Error {
  constructor(
    public code: "unsupported" | "empty" | "unreadable",
    message: string,
  ) {
    super(message);
  }
}

export async function extractResumeText(data: Uint8Array, filename: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  let text: string;

  try {
    if (ext === ".pdf") {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      text = (await extractText(pdf, { mergePages: true })).text;
    } else if (ext === ".docx") {
      text = (await mammoth.extractRawText({ buffer: Buffer.from(data) })).value;
    } else if (ext === ".txt" || ext === ".md") {
      text = Buffer.from(data).toString("utf8");
    } else {
      throw new ResumeParseError("unsupported", `Unsupported file type "${ext || filename}". Use PDF, DOCX, or TXT.`);
    }
  } catch (err) {
    if (err instanceof ResumeParseError) throw err;
    throw new ResumeParseError("unreadable", `Could not read this file: ${(err as Error).message}`);
  }

  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  if (text.length < 50) {
    // Usually a scanned (image-only) PDF.
    throw new ResumeParseError("empty", "No readable text found. If this is a scanned PDF, paste the text instead.");
  }
  return text;
}
