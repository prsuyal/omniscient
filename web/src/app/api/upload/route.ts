import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { env } from "~/env";
import { getServerAuthSession } from "~/server/auth";

const ALLOWED_TYPES = new Set(["application/pdf"]);

export async function POST(req: Request) {
  try {
    const session = await getServerAuthSession();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const formData = await req.formData();
    const files = formData.getAll("files").filter((f): f is File => f instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
    }

    const uploadRoot = path.resolve(process.cwd(), env.UPLOAD_DIR, userId);
    await mkdir(uploadRoot, { recursive: true });

    const uploaded: Array<{
      originalName: string;
      storedName: string;
      storedPath: string;
      mimeType: string;
      sizeBytes: number;
    }> = [];

    for (const file of files) {
      const mimeType = file.type || "application/octet-stream";
      const ext = path.extname(file.name).toLowerCase();

      if (!ALLOWED_TYPES.has(mimeType) && ext !== ".pdf") {
        return NextResponse.json(
          { error: `Unsupported file type for ${file.name}. Only PDFs are allowed.` },
          { status: 400 },
        );
      }

      const bytes = Buffer.from(await file.arrayBuffer());
      const storedName = `${Date.now()}-${randomUUID()}.pdf`;
      const storedPath = path.join(uploadRoot, storedName);
      await writeFile(storedPath, bytes);

      uploaded.push({
        originalName: file.name,
        storedName,
        storedPath,
        mimeType,
        sizeBytes: bytes.byteLength,
      });
    }

    return NextResponse.json({ files: uploaded }, { status: 200 });
  } catch (error) {
    console.error("File upload error", error);
    return NextResponse.json({ error: "Upload failed." }, { status: 500 });
  }
}
