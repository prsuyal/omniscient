import { readFile } from "node:fs/promises";

export const extractPdfText = async (filePath: string): Promise<string> => {
  const buffer = await readFile(filePath);

  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    return (parsed.text ?? "").trim();
  } catch (error) {
    throw new Error(
      `PDF extraction failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
