"use client";

import { useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  FileText,
  Loader2,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import type { BoundingBox, CompareResponse, FieldComparison, PageImage } from "@/lib/types";

type ProcessingStatus = "idle" | "processing" | "done" | "error";
type ActiveDoc = "reference" | "produced";

export default function Home() {
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [producedFile, setProducedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [activeDoc, setActiveDoc] = useState<ActiveDoc>("reference");
  const [activePage, setActivePage] = useState(0);
  const [selectedFieldKey, setSelectedFieldKey] = useState<string | null>(null);

  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  const producedInputRef = useRef<HTMLInputElement | null>(null);

  const canProcess = referenceFiles.length > 0 && producedFile !== null && status !== "processing";

  const activePages: PageImage[] = useMemo(() => {
    if (!result) return [];
    return activeDoc === "reference" ? result.referencePages : result.producedPages;
  }, [result, activeDoc]);

  const activeImage = activePages.find((p) => p.page === activePage) ?? activePages[0];

  function handleReferenceSelect(files: FileList | null) {
    if (!files) return;
    setReferenceFiles((prev) => [...prev, ...Array.from(files)]);
  }

  function handleProducedSelect(files: FileList | null) {
    if (!files || files.length === 0) return;
    setProducedFile(files[0]);
  }

  function removeReferenceFile(index: number) {
    setReferenceFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleProcess() {
    if (!producedFile || referenceFiles.length === 0) return;

    setStatus("processing");
    setErrorMessage(null);
    setResult(null);
    setSelectedFieldKey(null);

    try {
      const formData = new FormData();
      referenceFiles.forEach((file) => formData.append("reference_files", file));
      formData.append("produced_file", producedFile);

      const response = await fetch("/api/compare", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const detail = body && typeof body.detail === "string" ? body.detail : null;
        throw new Error(detail ?? `Erro ${response.status} ao processar documentos.`);
      }

      const data = (await response.json()) as CompareResponse;
      setResult(data);
      setActiveDoc("reference");
      setActivePage(0);
      setStatus("done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Erro desconhecido ao processar documentos.");
      setStatus("error");
    }
  }

  function boxesForActiveImage(): { field: FieldComparison; box: BoundingBox }[] {
    if (!result || !activeImage) return [];
    const boxes: { field: FieldComparison; box: BoundingBox }[] = [];
    for (const field of result.fields) {
      const box = activeDoc === "reference" ? field.referenceBoundingBox : field.producedBoundingBox;
      if (box && box.page === activeImage.page) {
        boxes.push({ field, box });
      }
    }
    return boxes;
  }

  function selectField(key: string) {
    setSelectedFieldKey((current) => (current === key ? null : key));
    if (!result) return;
    const field = result.fields.find((f) => f.key === key);
    const box = activeDoc === "reference" ? field?.referenceBoundingBox : field?.producedBoundingBox;
    if (box) {
      setActivePage(box.page);
    }
  }

  return (
    <div className="flex h-screen w-full flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
        <div>
          <h1 className="text-base font-semibold">Conferência de Documentos Aduaneiros</h1>
          <p className="text-xs text-slate-500">
            Compare um documento de Referência com um Doc Produzido — CNPJ, Razão Social, Endereço,
            Peso Bruto/Líquido e Valor Total.
          </p>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto p-6" style={{ flexBasis: "70%" }}>
          {status !== "done" ? (
            <UploadStage
              referenceFiles={referenceFiles}
              producedFile={producedFile}
              referenceInputRef={referenceInputRef}
              producedInputRef={producedInputRef}
              onReferenceSelect={handleReferenceSelect}
              onProducedSelect={handleProducedSelect}
              onRemoveReference={removeReferenceFile}
              onRemoveProduced={() => setProducedFile(null)}
              canProcess={canProcess}
              status={status}
              errorMessage={errorMessage}
              onProcess={handleProcess}
            />
          ) : (
            <Viewer
              activeDoc={activeDoc}
              onChangeDoc={(doc) => {
                setActiveDoc(doc);
                setActivePage(0);
              }}
              image={activeImage}
              pages={activePages}
              activePage={activePage}
              onChangePage={setActivePage}
              boxes={boxesForActiveImage()}
              selectedFieldKey={selectedFieldKey}
              onReset={() => {
                setStatus("idle");
                setResult(null);
                setReferenceFiles([]);
                setProducedFile(null);
              }}
            />
          )}
        </main>

        <aside
          className="flex flex-col overflow-y-auto border-l border-slate-200 bg-white p-5"
          style={{ flexBasis: "30%", maxWidth: 420 }}
        >
          <h2 className="mb-3 text-sm font-semibold">Relatório</h2>
          {!result ? (
            <p className="text-sm text-slate-500">
              Faça upload dos dois documentos e clique em &quot;Processar documentos&quot; para ver o
              relatório aqui.
            </p>
          ) : (
            <ReportPanel
              result={result}
              selectedFieldKey={selectedFieldKey}
              onSelectField={selectField}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

interface UploadStageProps {
  referenceFiles: File[];
  producedFile: File | null;
  referenceInputRef: React.RefObject<HTMLInputElement | null>;
  producedInputRef: React.RefObject<HTMLInputElement | null>;
  onReferenceSelect: (files: FileList | null) => void;
  onProducedSelect: (files: FileList | null) => void;
  onRemoveReference: (index: number) => void;
  onRemoveProduced: () => void;
  canProcess: boolean;
  status: ProcessingStatus;
  errorMessage: string | null;
  onProcess: () => void;
}

function UploadStage({
  referenceFiles,
  producedFile,
  referenceInputRef,
  producedInputRef,
  onReferenceSelect,
  onProducedSelect,
  onRemoveReference,
  onRemoveProduced,
  canProcess,
  status,
  errorMessage,
  onProcess,
}: UploadStageProps) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="grid grid-cols-2 gap-4">
        <UploadCard
          title="Referência"
          description="Ex: Invoice. Aceita múltiplos arquivos (PDF ou imagem)."
          onSelect={() => referenceInputRef.current?.click()}
        >
          <input
            ref={referenceInputRef}
            type="file"
            multiple
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) => onReferenceSelect(e.target.files)}
          />
          <ul className="mt-3 flex flex-col gap-2">
            {referenceFiles.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="flex items-center justify-between rounded-md border border-slate-200 px-2 py-1.5 text-xs"
              >
                <span className="flex items-center gap-1.5 truncate">
                  <FileText size={14} className="shrink-0 text-slate-400" />
                  <span className="truncate">{file.name}</span>
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveReference(index)}
                  className="shrink-0 text-slate-400 hover:text-red-500"
                  aria-label={`Remover ${file.name}`}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </UploadCard>

        <UploadCard
          title="Doc Produzido"
          description="Ex: Certificado de Origem. Um único arquivo."
          onSelect={() => producedInputRef.current?.click()}
        >
          <input
            ref={producedInputRef}
            type="file"
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) => onProducedSelect(e.target.files)}
          />
          {producedFile && (
            <div className="mt-3 flex items-center justify-between rounded-md border border-slate-200 px-2 py-1.5 text-xs">
              <span className="flex items-center gap-1.5 truncate">
                <FileText size={14} className="shrink-0 text-slate-400" />
                <span className="truncate">{producedFile.name}</span>
              </span>
              <button
                type="button"
                onClick={onRemoveProduced}
                className="shrink-0 text-slate-400 hover:text-red-500"
                aria-label={`Remover ${producedFile.name}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
        </UploadCard>
      </div>

      {status === "error" && errorMessage && (
        <div className="mt-4 flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          <XCircle size={16} className="shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      <button
        type="button"
        disabled={!canProcess}
        onClick={onProcess}
        className="mt-5 flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "processing" ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Processando documentos...
          </>
        ) : (
          "Processar documentos"
        )}
      </button>
    </div>
  );
}

interface UploadCardProps {
  title: string;
  description: string;
  onSelect: () => void;
  children?: React.ReactNode;
}

function UploadCard({ title, description, onSelect, children }: UploadCardProps) {
  return (
    <div className="rounded-xl border-2 border-dashed border-slate-200 bg-white p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-slate-500">{description}</p>
      <button
        type="button"
        onClick={onSelect}
        className="mt-3 flex items-center gap-2 rounded-md border border-blue-600 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
      >
        <Upload size={14} />
        Selecionar arquivo(s)
      </button>
      {children}
    </div>
  );
}

interface ViewerProps {
  activeDoc: ActiveDoc;
  onChangeDoc: (doc: ActiveDoc) => void;
  image: PageImage | undefined;
  pages: PageImage[];
  activePage: number;
  onChangePage: (page: number) => void;
  boxes: { field: FieldComparison; box: BoundingBox }[];
  selectedFieldKey: string | null;
  onReset: () => void;
}

function Viewer({
  activeDoc,
  onChangeDoc,
  image,
  pages,
  activePage,
  onChangePage,
  boxes,
  selectedFieldKey,
  onReset,
}: ViewerProps) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChangeDoc("reference")}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
              activeDoc === "reference"
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-slate-200 bg-white text-slate-600"
            }`}
          >
            Referência
          </button>
          <button
            type="button"
            onClick={() => onChangeDoc("produced")}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
              activeDoc === "produced"
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-slate-200 bg-white text-slate-600"
            }`}
          >
            Doc Produzido
          </button>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="text-xs font-medium text-slate-500 hover:text-slate-700"
        >
          Novo processamento
        </button>
      </div>

      {pages.length > 1 && (
        <div className="mb-3 flex gap-1.5">
          {pages.map((p) => (
            <button
              key={p.page}
              type="button"
              onClick={() => onChangePage(p.page)}
              className={`rounded px-2 py-1 text-xs ${
                activePage === p.page ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              Pág. {p.page + 1}
            </button>
          ))}
        </div>
      )}

      {image ? (
        <div className="relative max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white">
          <img src={image.dataUrl} alt={`Página ${image.page + 1}`} className="block w-full" />
          {boxes.map(({ field, box }) => {
            const isSelected = selectedFieldKey === null || selectedFieldKey === field.key;
            return (
              <div
                key={field.key}
                className="absolute rounded-sm border-[2.5px] transition-opacity"
                style={{
                  left: `${box.x * 100}%`,
                  top: `${box.y * 100}%`,
                  width: `${box.width * 100}%`,
                  height: `${box.height * 100}%`,
                  borderColor: field.match ? "#16a34a" : "#dc2626",
                  backgroundColor: field.match ? "rgba(22,163,74,0.08)" : "rgba(220,38,38,0.08)",
                  opacity: isSelected ? 1 : 0.15,
                }}
              />
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-slate-500">Nenhuma página disponível.</p>
      )}
    </div>
  );
}

interface ReportPanelProps {
  result: CompareResponse;
  selectedFieldKey: string | null;
  onSelectField: (key: string) => void;
}

function ReportPanel({ result, selectedFieldKey, onSelectField }: ReportPanelProps) {
  const mismatchCount = result.fields.filter((f) => !f.match).length;

  return (
    <div className="flex flex-col gap-3">
      <div
        className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
          result.overallMatch ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}
      >
        {result.overallMatch ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        {result.overallMatch
          ? "Todos os campos conferem"
          : `${mismatchCount} campo(s) não conferem`}
      </div>

      <div className="flex flex-col gap-2">
        {result.fields.map((field) => (
          <button
            key={field.key}
            type="button"
            onClick={() => onSelectField(field.key)}
            className={`rounded-lg border p-3 text-left text-xs transition ${
              selectedFieldKey === field.key
                ? "border-blue-500 ring-1 ring-blue-500"
                : "border-slate-200 hover:border-slate-300"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{field.label}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  field.match ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                }`}
              >
                {field.match ? "Confere" : "Não confere"}
              </span>
            </div>
            <div className="mt-1.5 flex flex-col gap-0.5 text-slate-500">
              <span>
                <strong className="text-slate-600">Ref: </strong>
                {field.referenceValue ?? "—"}
              </span>
              <span>
                <strong className="text-slate-600">Produzido: </strong>
                {field.producedValue ?? "—"}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
