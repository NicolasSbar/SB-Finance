/**
 * Tarjeta de vinculación privada multi-usuario con Telegram (`TelegramLinkCard`).
 *
 * Arquitectura y decisiones técnicas:
 * - Flujo seguro con código temporal de 15 minutos: el navegador genera un código de un
 *   solo uso en `telegram_link_codes` (protegido por RLS) y muestra un temporizador en
 *   vivo; el usuario lo envía desde su cuenta de Telegram con `/vincular CODIGO`.
 * - Desvinculación explícita con confirmación modal para evitar desconexiones accidentales.
 */
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { useAuth } from '../../hooks/useAuth';
import { formatCountdownMMSS, formatShortDate } from '../../lib/formatters';
import {
  generateTelegramLinkCode,
  getActiveLinkCode,
  getTelegramLink,
  unlinkTelegram,
} from '../../services/telegramService';
import type { TelegramLink, TelegramLinkCode } from '../../types/database.types';

const rawBotUsername = (
  (import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string | undefined) ?? ''
)
  .trim()
  .replace(/^@+/, '');
const TELEGRAM_BOT_USERNAME = rawBotUsername || 'SBFinanceBot';
const TELEGRAM_BOT_URL = `https://t.me/${TELEGRAM_BOT_USERNAME}`;
const TELEGRAM_BOT_HANDLE = `@${TELEGRAM_BOT_USERNAME}`;

export function TelegramLinkCard() {
  const { user } = useAuth();

  const [link, setLink] = useState<TelegramLink | null>(null);
  const [activeCode, setActiveCode] = useState<TelegramLinkCode | null>(null);
  const [isLoadingState, setIsLoadingState] = useState<boolean>(true);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState<boolean>(false);
  const [isUnlinkModalOpen, setIsUnlinkModalOpen] = useState<boolean>(false);
  const [isUnlinking, setIsUnlinking] = useState<boolean>(false);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  const loadLinkStatus = useCallback(
    async (silent = false) => {
      if (!user) return;
      if (!silent) setIsLoadingState(true);
      else setIsRefreshingStatus(true);

      try {
        const [linkData, codeData] = await Promise.all([
          getTelegramLink(user.id),
          getActiveLinkCode(user.id),
        ]);
        setLink(linkData);
        setActiveCode(codeData);
        setNowMs(Date.now());
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'No se pudo consultar el estado de vinculación con Telegram.';
        toast.error(msg);
      } finally {
        setIsLoadingState(false);
        setIsRefreshingStatus(false);
      }
    },
    [user],
  );

  const countdown = activeCode
    ? formatCountdownMMSS(activeCode.expires_at, nowMs)
    : null;
  const hasValidActiveCode = Boolean(
    activeCode && countdown && !countdown.isExpired,
  );

  useEffect(() => {
    void loadLinkStatus(false);
  }, [loadLinkStatus]);

  useEffect(() => {
    if (!hasValidActiveCode || link) return;
    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timerId);
  }, [hasValidActiveCode, link]);

  useEffect(() => {
    if (!hasValidActiveCode || link) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadLinkStatus(true);
      }
    };
    const handleWindowFocus = () => {
      void loadLinkStatus(true);
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [hasValidActiveCode, link, loadLinkStatus]);

  async function handleGenerateCode(): Promise<void> {
    if (!user) return;
    setIsGenerating(true);
    try {
      const codeRow = await generateTelegramLinkCode(user.id);
      setActiveCode(codeRow);
      setNowMs(Date.now());
      toast.success('Código generado. Enviá el comando al bot dentro de los 15 minutos.');
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo generar el código de vinculación.';
      toast.error(msg);
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopyCommand(): Promise<void> {
    if (!activeCode) return;
    const command = `/vincular ${activeCode.code}`;
    try {
      await navigator.clipboard.writeText(command);
      toast.success(`Comando "${command}" copiado al portapapeles.`);
    } catch {
      toast.error('No se pudo copiar automáticamente. Copialo manualmente.');
    }
  }

  async function handleConfirmUnlink(): Promise<void> {
    if (!user) return;
    setIsUnlinking(true);
    try {
      await unlinkTelegram(user.id);
      setLink(null);
      setActiveCode(null);
      setIsUnlinkModalOpen(false);
      toast.success('Telegram desvinculado de tu cuenta.');
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo desvincular Telegram.';
      toast.error(msg);
    } finally {
      setIsUnlinking(false);
    }
  }

  return (
    <>
      <Card padding="lg">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
          <div>
            <h2 className="text-lg font-bold text-[#FAFAFA]">
              Vinculación con Bot de Telegram
            </h2>
            <p className="mt-1 text-sm text-[#A3A3A3]">
              Registrá gastos, ingresos extra y compras en cuotas por texto o notas de voz (hasta 60 s) y recibí alertas en tiempo real.
            </p>
          </div>
          {isLoadingState ? (
            <Badge variant="neutral">Verificando...</Badge>
          ) : link ? (
            <Badge variant="green">Vinculado</Badge>
          ) : (
            <Badge variant="neutral">Sin vincular</Badge>
          )}
        </div>

        {isLoadingState ? (
          <div className="h-28 rounded-[8px] bg-[#0A0A0A] border border-[#262626] animate-pulse" />
        ) : link ? (
          <div className="rounded-[8px] border border-[#22C55E]/35 bg-[#0A0A0A] p-4 sm:p-5 flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wider text-[#A3A3A3]">
                  Chat de Telegram conectado
                </span>
                <p className="text-base font-bold text-[#FAFAFA]">
                  {link.telegram_username
                    ? `@${link.telegram_username}`
                    : `Chat ID ${link.telegram_chat_id}`}
                </p>
                <p className="text-xs text-[#A3A3A3]">
                  Vinculado el {formatShortDate(link.linked_at.slice(0, 10))} &bull; Relación privada 1:1 activa
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <a
                  href={TELEGRAM_BOT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-[6px] bg-[#1F1F1F] border border-[#333333] text-xs font-semibold text-[#FACC15] hover:border-[#FACC15]/60 transition-colors"
                >
                  Abrir {TELEGRAM_BOT_HANDLE} &nearr;
                </a>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadLinkStatus(true)}
                  isLoading={isRefreshingStatus}
                  loadingText="Verificando..."
                >
                  Actualizar estado
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setIsUnlinkModalOpen(true)}
                >
                  Desvincular Telegram
                </Button>
              </div>
            </div>

            <div className="pt-3 border-t border-[#1F1F1F] text-xs text-[#A3A3A3] leading-relaxed">
              Podés enviar audios o mensajes como{' '}
              <span className="text-[#FAFAFA] italic">
                &ldquo;Gasté 15.000 en delivery, me di un gustito&rdquo;
              </span>{' '}
              o{' '}
              <span className="text-[#FAFAFA] italic">
                &ldquo;Compré auriculares en 3 cuotas de 25.000, primera cuota el 10/12/2026&rdquo;
              </span>
              . Cada registro incluye el botón <strong className="text-[#D4D4D4]">[❌ Anular]</strong> válido por 24 horas.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-[8px] border border-[#262626] bg-[#0A0A0A] p-4 flex flex-col gap-3">
              <p className="text-sm font-medium text-[#FAFAFA]">
                ¿Cómo vincular tu cuenta paso a paso?
              </p>
              <ol className="list-decimal list-inside text-sm text-[#A3A3A3] space-y-1.5 leading-relaxed">
                <li>
                  Presioná <strong className="text-[#FAFAFA]">Generar código de vinculación</strong> (dura 15 minutos).
                </li>
                <li>
                  Entrá al bot{' '}
                  <a
                    href={TELEGRAM_BOT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-[#FACC15] hover:underline"
                  >
                    {TELEGRAM_BOT_HANDLE}
                  </a>{' '}
                  en Telegram y tocá <strong className="text-[#FAFAFA]">Iniciar</strong> (o enviá{' '}
                  <code className="font-mono text-[#FAFAFA]">/start</code>).
                </li>
                <li>
                  Mandale el comando{' '}
                  <code className="font-mono text-[#FACC15]">/vincular CODIGO</code>{' '}
                  (con el botón <strong className="text-[#FAFAFA]">Copiar comando</strong> podés pegarlo directo).
                </li>
                <li>
                  Volvé acá y presioná <strong className="text-[#FAFAFA]">Actualizar estado</strong> para confirmar la conexión.
                </li>
              </ol>

              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <Button
                  variant="primary"
                  onClick={() => void handleGenerateCode()}
                  isLoading={isGenerating}
                  loadingText="Generando código..."
                >
                  Generar código de vinculación
                </Button>
                <a
                  href={TELEGRAM_BOT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-[6px] bg-[#1F1F1F] border border-[#333333] text-sm font-semibold text-[#FACC15] hover:border-[#FACC15]/60 transition-colors"
                >
                  Abrir bot en Telegram &nearr;
                </a>
                <Button
                  variant="secondary"
                  onClick={() => void loadLinkStatus(true)}
                  isLoading={isRefreshingStatus}
                  loadingText="Actualizando..."
                >
                  Actualizar estado
                </Button>
              </div>
            </div>

            {activeCode ? (
              <div
                className={[
                  'rounded-[8px] border p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4',
                  hasValidActiveCode
                    ? 'border-[#FACC15]/50 bg-[#FACC15]/5'
                    : 'border-[#EF4444]/50 bg-[#EF4444]/10',
                ].join(' ')}
              >
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
                    {hasValidActiveCode
                      ? 'Enviá este comando al bot de Telegram'
                      : 'Código expirado'}
                  </span>
                  <div className="flex flex-wrap items-baseline gap-3">
                    <code className="font-mono tracking-widest text-2xl font-extrabold text-[#FACC15]">
                      {activeCode.code}
                    </code>
                    <span
                      className={[
                        'font-mono-num text-xs font-semibold',
                        hasValidActiveCode ? 'text-[#D4D4D4]' : 'text-[#F87171]',
                      ].join(' ')}
                    >
                      {hasValidActiveCode && countdown
                        ? `Expira en ${countdown.formatted}`
                        : 'Expirado — generá uno nuevo'}
                    </span>
                  </div>
                  <p className="text-xs text-[#A3A3A3]">
                    Comando completo:{' '}
                    <code className="font-mono text-[#FAFAFA]">
                      /vincular {activeCode.code}
                    </code>
                  </p>
                </div>

                {hasValidActiveCode ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleCopyCommand()}
                    className="shrink-0"
                  >
                    Copiar comando
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <Modal
        isOpen={isUnlinkModalOpen}
        onClose={() => setIsUnlinkModalOpen(false)}
        title="Desvincular Telegram"
        description="Tu bot dejará de registrar movimientos y enviar alertas en este chat hasta que vuelvas a vincularlo."
        size="sm"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[#D4D4D4]">
            Los movimientos que ya cargaste desde Telegram permanecerán intactos en tu historial de SB-Finance.
          </p>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
            <Button
              variant="secondary"
              onClick={() => setIsUnlinkModalOpen(false)}
              disabled={isUnlinking}
            >
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleConfirmUnlink()}
              isLoading={isUnlinking}
              loadingText="Desvinculando..."
            >
              Confirmar desvinculación
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
