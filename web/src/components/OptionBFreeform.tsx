"use client";

import { useState } from "react";

import { NutritionFreeform } from "~/components/NutritionFreeform";

export type UploadedFileMeta = {
  originalName: string;
  storedName: string;
  storedPath: string;
  mimeType: string;
  sizeBytes: number;
};

export type OptionBPayload = {
  freeformText?: string | null;
  nutritionFreeform?: string | null;
  files: UploadedFileMeta[];
};

type UploadApiResponse = {
  files?: UploadedFileMeta[];
  error?: string;
};

export function OptionBFreeform({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting: boolean;
  onSubmit: (payload: OptionBPayload) => void;
}) {
  const [freeformText, setFreeformText] = useState("");
  const [nutritionFreeform, setNutritionFreeform] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = async (): Promise<UploadedFileMeta[]> => {
    if (!selectedFiles.length) return [];

    const formData = new FormData();
    for (const file of selectedFiles) {
      formData.append("files", file);
    }

    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const json = (await response.json()) as UploadApiResponse;

    if (!response.ok) {
      throw new Error(json.error ?? "Upload failed.");
    }

    return json.files ?? [];
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setUploadError(null);

        try {
          setIsUploading(true);
          const uploaded = await handleUpload();
          onSubmit({
            freeformText: freeformText.trim() ? freeformText.trim() : null,
            nutritionFreeform: nutritionFreeform.trim() ? nutritionFreeform.trim() : null,
            files: uploaded,
          });
        } catch (error) {
          setUploadError(error instanceof Error ? error.message : String(error));
        } finally {
          setIsUploading(false);
        }
      }}
    >
      <label className="grid gap-1 text-sm">
        <span>Freeform medical info</span>
        <textarea
          value={freeformText}
          onChange={(event) => setFreeformText(event.target.value)}
          className="ui-textarea min-h-40"
          placeholder="Paste history, symptoms, labs, family history, habits, or anything relevant."
        />
      </label>

      <NutritionFreeform value={nutritionFreeform} onChange={setNutritionFreeform} />

      <label className="grid gap-1 text-sm">
        <span>Upload PDF bloodwork</span>
        <input
          type="file"
          accept="application/pdf,.pdf"
          multiple
          onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
          className="ui-input"
        />
      </label>

      {selectedFiles.length ? (
        <div className="app-muted-panel p-2 text-xs text-white/80">
          <div className="mb-1 font-medium">Selected files</div>
          <ul className="grid gap-1">
            {selectedFiles.map((file) => (
              <li key={`${file.name}-${file.size}`}>{file.name}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {uploadError ? <p className="text-sm text-red-300">{uploadError}</p> : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isSubmitting || isUploading}
          className="ui-btn ui-btn-primary"
        >
          {isSubmitting || isUploading ? "Running..." : "Run Pipeline"}
        </button>
      </div>
    </form>
  );
}
