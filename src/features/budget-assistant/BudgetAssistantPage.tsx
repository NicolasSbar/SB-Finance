/**
 * Página dedicada del Asistente de Distribución de Presupuesto con IA (`/budget-assistant`).
 *
 * Arquitectura y decisiones técnicas:
 * - Separa el análisis de IA (`generateBudgetProposal`) en la Edge Function
 *   `budget-assistant` de la aplicación de límites (`applySuggestedLimits`), permitiendo
 *   al usuario inspeccionar cada cifra propuesta (*Actual vs. Sugerido* con deltas `+$X`/`-$X`),
 *   leer las justificaciones y decidir explícitamente si aplica también al mes en curso.
 * - Integra `PageSubnav` (`group="tools"`), chips de contexto previo (`useDashboardData`
 *   + cantidad de ítems en Matriz de Prioridad), atajos de objetivo rápido y grabador
 *   nativo `MediaRecorder` (máx. 60 segundos, cero librerías externas) para enviar
 *   instrucciones por voz o texto al análisis multimodal.
 * - Incluye aviso orientativo/legal obligatorio y estado preventivo amigable cuando
 *   falta configurar el sueldo fijo mensual.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { PageSubnav } from '../../components/layout/PageSubnav';
import { Badge, type BadgeVariant } from '../../components/ui/Badge';
import { Button, linkButtonClasses } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { InputField } from '../../components/ui/InputField';
import { useAuth } from '../../hooks/useAuth';
import { useDashboardData } from '../../hooks/useDashboardData';
import {
  formatCurrency,
  formatMonthLabel,
  toCents,
  toMonthStartISODate,
} from '../../lib/formatters';
import {
  applySuggestedLimits,
  generateBudgetProposal,
} from '../../services/budgetAssistantService';
import { getPriorityItems } from '../../services/priorityMatrixService';
import type {
  BudgetAssistantProposal,
  BudgetAssistantResponse,
} from '../../types/database.types';

const MAX_AUDIO_SECONDS = 60;
const MAX_AUDIO_BYTES = 3_500_000;

interface RecordedAudioClip {
  url: string;
  base64: string;
  mimeType: string;
  durationSeconds: number;
}

function formatRecordingTimer(seconds: number): string {
  const clamped = Math.max(0, Math.min(MAX_AUDIO_SECONDS, Math.floor(seconds)));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function pickSupportedRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('No se pudo leer el audio grabado.'));
        return;
      }
      const commaIndex = reader.result.indexOf(',');
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };
    reader.onerror = () => reject(new Error('Error al codificar el audio grabado.'));
    reader.readAsDataURL(blob);
  });
}

interface QuickGoalChip {
  id: string;
  label: string;
  text: string;
}

const QUICK_GOAL_CHIPS: readonly QuickGoalChip[] = [
  {
    id: 'save-more',
    label: 'Ahorrar más',
    text: 'Quiero priorizar aumentar mi ahorro mensual objetivo sin descuidar mis compromisos fijos.',
  },
  {
    id: 'reduce-fixed',
    label: 'Reducir gastos fijos',
    text: 'Necesito ajustar los topes por categoría para reducir gastos fijos y liberar disponible real.',
  },
  {
    id: 'order-gustitos',
    label: 'Ordenar gustitos',
    text: 'Quiero ordenar mi presupuesto de Gustitos para evitar desvíos a fin de mes.',
  },
];

interface DeltaPillInfo {
  label: string;
  variant: BadgeVariant;
}

function getDeltaPillInfo(
  currentValue: number | null,
  suggestedValue: number | null,
  currency: string,
  higherIsBetter = false,
): DeltaPillInfo | null {
  if (currentValue === null && suggestedValue === null) {
    return { label: 'Sin cambios', variant: 'neutral' };
  }
  if (currentValue === null && suggestedValue !== null) {
    return { label: `Nuevo: ${formatCurrency(suggestedValue, currency)}`, variant: 'yellow' };
  }
  if (currentValue !== null && suggestedValue === null) {
    return { label: 'Quitar tope', variant: 'neutral' };
  }
  if (currentValue === null || suggestedValue === null) {
    return null;
  }

  const deltaCents = toCents(suggestedValue) - toCents(currentValue);
  if (deltaCents === 0) {
    return { label: 'Sin cambios', variant: 'neutral' };
  }

  const formattedDiff = formatCurrency(Math.abs(deltaCents) / 100, currency);
  const sign = deltaCents > 0 ? '+' : '-';
  const isPositiveOutcome = higherIsBetter ? deltaCents > 0 : deltaCents < 0;

  return {
    label: `${sign}${formattedDiff}`,
    variant: isPositiveOutcome ? 'green' : 'red',
  };
}

export function BudgetAssistantPage() {
  const { user, userSettings, refreshSettings } = useAuth();
  const [userGoal, setUserGoal] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [applyToCurrentMonth, setApplyToCurrentMonth] = useState(true);
  const [responseState, setResponseState] =
    useState<BudgetAssistantResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [priorityItemsCount, setPriorityItemsCount] = useState<number | null>(null);

  // Grabación nativa de audio (máx. 60 segundos)
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedAudio, setRecordedAudio] = useState<RecordedAudioClip | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number>(0);

  const currency = userSettings?.currency ?? 'ARS';
  const fixedSalary = userSettings?.fixed_salary ?? 0;
  const currentMonthDate = toMonthStartISODate(new Date());
  const currentMonthLabel = formatMonthLabel(currentMonthDate);
  const {
    summary,
    evolution,
    isLoading: isContextLoading,
  } = useDashboardData(currentMonthDate, {
    includeEvolution: true,
    includeTransactions: false,
  });

  useEffect(() => {
    let active = true;
    if (!user) return;
    getPriorityItems()
      .then((list) => {
        if (active) setPriorityItemsCount(list.length);
      })
      .catch(() => {
        if (active) setPriorityItemsCount(null);
      });
    return () => {
      active = false;
    };
  }, [user]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current !== null) {
        window.clearInterval(recordingTimerRef.current);
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== 'inactive'
      ) {
        mediaRecorderRef.current.stop();
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (recordedAudio?.url) {
        URL.revokeObjectURL(recordedAudio.url);
      }
    };
  }, [recordedAudio]);

  const monthsWithDataCount = useMemo(() => {
    if (responseState?.monthsAnalyzedCount !== undefined) {
      return responseState.monthsAnalyzedCount;
    }
    return evolution.filter(
      (point) =>
        point.totalExpenses > 0 ||
        point.committedTotal > 0 ||
        point.variableExpenses > 0,
    ).length;
  }, [evolution, responseState?.monthsAnalyzedCount]);

  function handleQuickGoalSelect(chipText: string): void {
    setUserGoal((prev) => {
      const trimmed = prev.trim();
      if (!trimmed || QUICK_GOAL_CHIPS.some((c) => c.text === trimmed)) {
        return chipText;
      }
      if (trimmed.includes(chipText)) {
        return trimmed;
      }
      return `${trimmed}. ${chipText}`.slice(0, 500);
    });
  }

  function clearRecordedAudio(): void {
    setAudioError(null);
    setRecordedAudio(null);
  }

  function stopAudioRecording(): void {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    setIsRecording(false);
  }

  async function startAudioRecording(): Promise<void> {
    setAudioError(null);
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      const msg =
        'Tu navegador no soporta grabación de audio desde el micrófono.';
      setAudioError(msg);
      toast.error(msg);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      recordingChunksRef.current = [];
      setRecordedAudio(null);

      const preferredMime = pickSupportedRecorderMimeType();
      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordingChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        if (recordingTimerRef.current !== null) {
          window.clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        setIsRecording(false);

        const elapsed = Math.max(
          1,
          Math.min(
            MAX_AUDIO_SECONDS,
            Math.round((Date.now() - recordingStartedAtRef.current) / 1000),
          ),
        );
        const resolvedMime =
          recorder.mimeType || preferredMime || 'audio/webm';
        const blob = new Blob(recordingChunksRef.current, {
          type: resolvedMime,
        });

        if (blob.size === 0) {
          setAudioError('No se capturó audio. Intentá grabar nuevamente.');
          return;
        }

        if (blob.size > MAX_AUDIO_BYTES) {
          const msg =
            'El audio supera el tamaño máximo permitido (3,5 MB). Grabá un mensaje más breve.';
          setAudioError(msg);
          toast.error(msg);
          return;
        }

        try {
          const base64 = await blobToBase64(blob);
          const url = URL.createObjectURL(blob);
          setRecordedAudio({
            url,
            base64,
            mimeType: resolvedMime,
            durationSeconds: elapsed,
          });
        } catch (convErr) {
          const msg =
            convErr instanceof Error
              ? convErr.message
              : 'No se pudo procesar el audio grabado.';
          setAudioError(msg);
          toast.error(msg);
        }
      };

      recordingStartedAtRef.current = Date.now();
      setRecordingSeconds(0);
      setIsRecording(true);
      recorder.start(250);

      recordingTimerRef.current = window.setInterval(() => {
        const secs = Math.floor(
          (Date.now() - recordingStartedAtRef.current) / 1000,
        );
        if (secs >= MAX_AUDIO_SECONDS) {
          setRecordingSeconds(MAX_AUDIO_SECONDS);
          stopAudioRecording();
          toast('Grabación finalizada al alcanzar el máximo de 60 segundos.');
        } else {
          setRecordingSeconds(secs);
        }
      }, 250);
    } catch (err) {
      setIsRecording(false);
      const isDenied =
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      const msg = isDenied
        ? 'No otorgaste permiso para usar el micrófono. Habilitalo en tu navegador e intentá nuevamente.'
        : 'No se pudo acceder al micrófono de tu dispositivo.';
      setAudioError(msg);
      toast.error(msg);
    }
  }

  async function handleGenerate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isRecording) {
      toast.error('Detené la grabación de audio antes de analizar.');
      return;
    }
    setError(null);
    setIsGenerating(true);

    try {
      const res = await generateBudgetProposal({
        userGoal,
        audioBase64: recordedAudio?.base64,
        audioMimeType: recordedAudio?.mimeType,
        audioDurationSeconds: recordedAudio?.durationSeconds,
      });
      setResponseState(res);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo obtener la sugerencia de presupuesto.';
      setError(msg);
      toast.error(msg);
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleApplyProposal(
    proposal: BudgetAssistantProposal,
  ): Promise<void> {
    if (!user) return;
    setIsApplying(true);
    try {
      await applySuggestedLimits(user.id, proposal, applyToCurrentMonth);
      await refreshSettings();
      toast.success(
        applyToCurrentMonth
          ? `Límites sugeridos aplicados a tu configuración base y a ${currentMonthLabel}.`
          : 'Límites sugeridos guardados como base para los próximos meses.',
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudieron aplicar los límites sugeridos.';
      toast.error(msg);
    } finally {
      setIsApplying(false);
    }
  }

  const proposal =
    responseState?.status === 'ok' ? (responseState.proposal ?? null) : null;

  const fixedLimitDelta = proposal
    ? getDeltaPillInfo(
        userSettings?.fixed_expenses_limit ?? 0,
        proposal.recommended_fixed_expenses_limit,
        currency,
      )
    : null;
  const gustitosDelta = proposal
    ? getDeltaPillInfo(
        userSettings?.gustitos_budget ?? 0,
        proposal.recommended_gustitos_budget,
        currency,
      )
    : null;
  const savingsDelta = proposal
    ? getDeltaPillInfo(
        userSettings?.monthly_savings_target ?? 0,
        proposal.recommended_monthly_savings_target,
        currency,
        true,
      )
    : null;

  return (
    <div className="flex flex-col gap-6">
      <PageSubnav group="tools" />

      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
            Asistente de Presupuesto con IA
          </h1>
          <p className="mt-1 text-sm sm:text-[15px] text-[#A3A3A3]">
            Analiza tu sueldo fijo, tu historial y compromisos vigentes con datos reales para sugerirte topes equilibrados y una meta de ahorro.
          </p>
        </div>

        <Badge variant="yellow">Gemini Flash &middot; Orientativo</Badge>
      </div>

      {/* Chips de contexto previo */}
      <div
        aria-label="Contexto financiero considerado"
        className="flex flex-wrap items-center gap-2"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#262626] bg-[#121212] px-3 py-1.5 text-xs text-[#D4D4D4]">
          <span className="text-[#A3A3A3]">Sueldo:</span>
          <strong className="font-mono-num text-[#FAFAFA]">
            {formatCurrency(fixedSalary, currency)}
          </strong>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#262626] bg-[#121212] px-3 py-1.5 text-xs text-[#D4D4D4]">
          <span className="text-[#A3A3A3]">Compromisos:</span>
          <strong className="font-mono-num text-[#FAFAFA]">
            {isContextLoading
              ? 'Cargando...'
              : formatCurrency(summary.totalCommitted, currency)}
          </strong>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#262626] bg-[#121212] px-3 py-1.5 text-xs text-[#D4D4D4]">
          <span className="text-[#A3A3A3]">Meses con datos:</span>
          <strong className="font-mono-num text-[#FACC15]">
            {isContextLoading ? '...' : monthsWithDataCount}
          </strong>
        </span>
        {priorityItemsCount !== null ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#262626] bg-[#121212] px-3 py-1.5 text-xs text-[#D4D4D4]">
            <span className="text-[#A3A3A3]">En matriz:</span>
            <strong className="font-mono-num text-[#FAFAFA]">
              {priorityItemsCount} {priorityItemsCount === 1 ? 'ítem' : 'ítems'}
            </strong>
          </span>
        ) : null}
      </div>

      {/* Estado preventivo si el sueldo fijo está en $0 */}
      {fixedSalary <= 0 ? (
        <Card padding="lg" highlight="yellow" className="flex flex-col gap-3">
          <h2 className="text-base font-bold text-[#FAFAFA]">
            Configurá primero tu Sueldo Fijo Mensual
          </h2>
          <p className="text-sm text-[#D4D4D4] leading-relaxed">
            Para calcular límites realistas de Gastos Fijos, Gustitos, Categorías y Ahorro Objetivo, el asistente necesita conocer tu ingreso fijo mensual en Configuración.
          </p>
          <div>
            <Link to="/settings" className={linkButtonClasses('primary', 'md')}>
              Ir a Configuración &rarr;
            </Link>
          </div>
        </Card>
      ) : (
        <Card padding="md" className="flex flex-col gap-4">
          <form onSubmit={handleGenerate} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-[#A3A3A3]">
                Objetivos rápidos (opcional)
              </span>
              <div className="flex flex-wrap gap-2">
                {QUICK_GOAL_CHIPS.map((chip) => {
                  const isActive = userGoal.trim() === chip.text;
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => handleQuickGoalSelect(chip.text)}
                      className={[
                        'btn-press min-h-[44px] px-3.5 rounded-full border text-xs font-semibold transition-colors cursor-pointer',
                        isActive
                          ? 'bg-[#FACC15] text-[#0A0A0A] border-[#FACC15]'
                          : 'bg-[#0A0A0A] text-[#D4D4D4] border-[#262626] hover:border-[#FACC15]/60 hover:text-[#FAFAFA]',
                      ].join(' ')}
                    >
                      {chip.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
                <div className="lg:col-span-8">
                  <InputField
                    label="Meta u observación opcional para este análisis"
                    placeholder="Ej. Quiero comprarme un ítem de mi matriz en 3 meses, ¿cómo me planifico?"
                    maxLength={500}
                    value={userGoal}
                    onChange={(e) => setUserGoal(e.target.value)}
                  />
                </div>
                <div className="lg:col-span-4">
                  <Button
                    type="submit"
                    variant="primary"
                    className="w-full"
                    disabled={isRecording}
                    isLoading={isGenerating}
                    loadingText="Analizando tu historial y compromisos..."
                  >
                    Analizar y sugerir presupuesto
                  </Button>
                </div>
              </div>

              {/* Grabación de audio con micrófono (máx. 60s) */}
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  {isRecording ? (
                    <button
                      type="button"
                      onClick={stopAudioRecording}
                      className="btn-press inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-[6px] border border-[#EF4444] bg-[#EF4444]/15 text-xs font-bold text-[#F87171] hover:bg-[#EF4444]/25 transition-colors cursor-pointer"
                    >
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 rounded-full bg-[#EF4444] animate-pulse"
                      />
                      <span>
                        Detener grabación ({formatRecordingTimer(recordingSeconds)} / 01:00)
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void startAudioRecording()}
                      disabled={isGenerating}
                      className="btn-press inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-[6px] border border-[#262626] bg-[#0A0A0A] text-xs font-semibold text-[#D4D4D4] hover:border-[#FACC15]/60 hover:text-[#FAFAFA] disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      <svg
                        className="w-4 h-4 text-[#FACC15]"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" x2="12" y1="19" y2="22" />
                      </svg>
                      <span>
                        {recordedAudio ? 'Grabar otro audio' : 'Grabar consulta por audio (máx. 60s)'}
                      </span>
                    </button>
                  )}

                  <span className="text-[13px] text-[#A3A3A3]">
                    Base actual: sueldo fijo{' '}
                    <span className="font-mono-num text-[#D4D4D4]">
                      {formatCurrency(fixedSalary, currency)}
                    </span>
                    .
                  </span>
                </div>

                {audioError ? (
                  <p role="alert" className="text-xs font-medium text-[#EF4444]">
                    {audioError}
                  </p>
                ) : null}

                {recordedAudio ? (
                  <div className="rounded-[8px] border border-[#262626] bg-[#0A0A0A] p-3 flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="yellow">
                        Audio {formatRecordingTimer(recordedAudio.durationSeconds)}
                      </Badge>
                    </div>
                    <audio
                      controls
                      src={recordedAudio.url}
                      aria-label="Vista previa del audio grabado"
                      className="w-full h-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearRecordedAudio}
                      disabled={isGenerating}
                      className="shrink-0"
                    >
                      Descartar
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          </form>
        </Card>
      )}

      {error ? (
        <div
          role="alert"
          className="rounded-[8px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-4 text-sm text-[#FAFAFA]"
        >
          {error}
        </div>
      ) : null}

      {responseState?.status === 'insufficient_data' ? (
        <Card padding="md" highlight="yellow" className="flex flex-col gap-3">
          <h2 className="text-base font-bold text-[#FAFAFA]">
            Datos insuficientes para generar una propuesta
          </h2>
          <p className="text-sm text-[#D4D4D4]">{responseState.message}</p>
          <div>
            <Link to="/settings" className={linkButtonClasses('secondary', 'sm')}>
              Revisar Configuración &rarr;
            </Link>
          </div>
        </Card>
      ) : null}

      {proposal ? (
        <div className="flex flex-col gap-5">
          {/* Diagnóstico general y advertencias */}
          <Card padding="md" highlight="yellow" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-[#FAFAFA]">
                Distribución Sugerida
              </h2>
              <Badge variant="neutral">
                {responseState?.monthsAnalyzedCount ?? 0} mes(es) analizado(s)
              </Badge>
            </div>

            <p className="text-sm text-[#D4D4D4] leading-relaxed">
              {proposal.summary_reasoning}
            </p>

            {proposal.warnings.length > 0 ? (
              <div className="rounded-[6px] border border-[#FACC15]/40 bg-[#FACC15]/8 p-3.5 flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-[#FACC15]">
                  Observaciones a tener en cuenta
                </span>
                <ul className="list-disc list-inside text-xs sm:text-sm text-[#FAFAFA] space-y-1">
                  {proposal.warnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          {/* Comparativa de topes globales */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card padding="md" className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-[#A3A3A3]">
                Límite Fijos + Cuotas
              </span>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs text-[#A3A3A3]">
                  Actual:{' '}
                  <span className="font-mono-num">
                    {formatCurrency(userSettings?.fixed_expenses_limit ?? 0, currency)}
                  </span>
                </span>
                {fixedLimitDelta ? (
                  <Badge variant={fixedLimitDelta.variant} className="font-mono-num">
                    {fixedLimitDelta.label}
                  </Badge>
                ) : (
                  <Badge variant="yellow">Sugerido</Badge>
                )}
              </div>
              <p className="font-mono-num text-2xl font-extrabold text-[#FACC15]">
                {formatCurrency(proposal.recommended_fixed_expenses_limit, currency)}
              </p>
            </Card>

            <Card padding="md" className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-[#A3A3A3]">
                Presupuesto de Gustitos
              </span>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs text-[#A3A3A3]">
                  Actual:{' '}
                  <span className="font-mono-num">
                    {formatCurrency(userSettings?.gustitos_budget ?? 0, currency)}
                  </span>
                </span>
                {gustitosDelta ? (
                  <Badge variant={gustitosDelta.variant} className="font-mono-num">
                    {gustitosDelta.label}
                  </Badge>
                ) : (
                  <Badge variant="yellow">Sugerido</Badge>
                )}
              </div>
              <p className="font-mono-num text-2xl font-extrabold text-[#FACC15]">
                {formatCurrency(proposal.recommended_gustitos_budget, currency)}
              </p>
            </Card>

            <Card padding="md" className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-[#A3A3A3]">
                Ahorro Mensual Objetivo
              </span>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs text-[#A3A3A3]">
                  Actual:{' '}
                  <span className="font-mono-num">
                    {formatCurrency(userSettings?.monthly_savings_target ?? 0, currency)}
                  </span>
                </span>
                {savingsDelta ? (
                  <Badge variant={savingsDelta.variant} className="font-mono-num">
                    {savingsDelta.label}
                  </Badge>
                ) : (
                  <Badge variant="green">Meta sugerida</Badge>
                )}
              </div>
              <p className="font-mono-num text-2xl font-extrabold text-[#22C55E]">
                {formatCurrency(proposal.recommended_monthly_savings_target, currency)}
              </p>
            </Card>
          </div>

          {/* Tabla comparativa por categoría (Desktop) y tarjetas (Mobile) */}
          {proposal.category_limits.length > 0 ? (
            <>
              <Card padding="none" className="hidden md:block overflow-hidden">
                <div className="px-5 py-4 border-b border-[#262626]">
                  <h3 className="text-base font-bold text-[#FAFAFA]">
                    Límites sugeridos por categoría
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table
                    aria-label="Comparativa de límites actuales y sugeridos por categoría"
                    className="w-full text-left border-collapse"
                  >
                    <thead>
                      <tr className="border-b border-[#262626] bg-[#0F0F0F] text-xs font-semibold text-[#A3A3A3]">
                        <th scope="col" className="py-3 px-4">
                          Categoría
                        </th>
                        <th scope="col" className="py-3 px-4 text-right">
                          Límite Actual
                        </th>
                        <th scope="col" className="py-3 px-4 text-right">
                          Límite Sugerido
                        </th>
                        <th scope="col" className="py-3 px-4 text-right">
                          Diferencia
                        </th>
                        <th scope="col" className="py-3 px-4">
                          Justificación
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1E1E1E] text-sm">
                      {proposal.category_limits.map((cat) => {
                        const catDelta = getDeltaPillInfo(
                          cat.current_limit,
                          cat.suggested_limit,
                          currency,
                        );
                        return (
                          <tr key={cat.category_id} className="hover:bg-[#171717]">
                            <td className="py-3 px-4 font-semibold text-[#FAFAFA]">
                              {cat.category_name}
                            </td>
                            <td className="py-3 px-4 text-right font-mono-num text-[#A3A3A3]">
                              {cat.current_limit !== null
                                ? formatCurrency(cat.current_limit, currency)
                                : 'Sin tope'}
                            </td>
                            <td className="py-3 px-4 text-right font-mono-num font-bold text-[#FACC15]">
                              {cat.suggested_limit !== null
                                ? formatCurrency(cat.suggested_limit, currency)
                                : 'Sin tope'}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              {catDelta ? (
                                <Badge variant={catDelta.variant} className="font-mono-num">
                                  {catDelta.label}
                                </Badge>
                              ) : null}
                            </td>
                            <td className="py-3 px-4 text-xs text-[#D4D4D4] leading-relaxed">
                              {cat.reason}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div className="flex flex-col gap-3 md:hidden">
                <h3 className="text-base font-bold text-[#FAFAFA]">
                  Límites sugeridos por categoría
                </h3>
                {proposal.category_limits.map((cat) => {
                  const catDelta = getDeltaPillInfo(
                    cat.current_limit,
                    cat.suggested_limit,
                    currency,
                  );
                  return (
                    <Card key={cat.category_id} padding="sm" className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-bold text-[#FAFAFA]">
                          {cat.category_name}
                        </span>
                        <div className="flex items-center gap-2">
                          {catDelta ? (
                            <Badge variant={catDelta.variant} className="font-mono-num">
                              {catDelta.label}
                            </Badge>
                          ) : null}
                          <span className="font-mono-num text-sm font-bold text-[#FACC15]">
                            {cat.suggested_limit !== null
                              ? formatCurrency(cat.suggested_limit, currency)
                              : 'Sin tope'}
                          </span>
                        </div>
                      </div>
                      <span className="text-xs text-[#A3A3A3]">
                        Actual:{' '}
                        {cat.current_limit !== null
                          ? formatCurrency(cat.current_limit, currency)
                          : 'Sin tope'}
                      </span>
                      <p className="text-xs text-[#D4D4D4]">{cat.reason}</p>
                    </Card>
                  );
                })}
              </div>
            </>
          ) : null}

          {/* Aviso orientativo legal + Aplicar límites sugeridos */}
          <Card padding="md" className="flex flex-col gap-4">
            <div
              role="note"
              className="rounded-[6px] border border-[#262626] bg-[#0A0A0A] p-3.5 text-xs text-[#A3A3A3] leading-relaxed"
            >
              <strong className="text-[#FAFAFA]">Aviso orientativo:</strong>{' '}
              {proposal.disclaimer}
            </div>

            <label
              htmlFor="assistant-apply-current-month"
              className="flex items-start gap-3 min-h-[44px] rounded-[6px] border border-[#262626] bg-[#0A0A0A] px-3.5 py-3 cursor-pointer hover:border-[#404040]"
            >
              <input
                id="assistant-apply-current-month"
                type="checkbox"
                checked={applyToCurrentMonth}
                onChange={(e) => setApplyToCurrentMonth(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#FACC15]"
              />
              <span className="text-sm text-[#D4D4D4] leading-snug">
                <strong className="text-[#FAFAFA]">Aplicar también al mes en curso</strong> ({currentMonthLabel}). Si lo desmarcás, los nuevos topes quedarán guardados como base para los meses futuros sin alterar el mes actual ni los cierres pasados.
              </span>
            </label>

            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={() => void handleApplyProposal(proposal)}
                isLoading={isApplying}
                loadingText="Aplicando límites..."
              >
                Aplicar límites sugeridos
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
