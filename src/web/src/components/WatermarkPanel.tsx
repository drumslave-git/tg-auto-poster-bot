import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api';
import type { Status } from '../types';
import { Button, Card, Check, Field } from './ui';

/** The preview frame's shape, so the vertical maths has something to work in. */
const FRAME_ASPECT = 16 / 9;

type Natural = { width: number; height: number };

/**
 * The same geometry the server computes with ffmpeg, in percentages of the
 * frame: the watermark is `scale`% of the width, and then sits `x`% of the way
 * through whatever room is left over — which is what keeps 100% flush with the
 * edge instead of over it.
 */
function placementStyle(
  x: number,
  y: number,
  scale: number,
  natural: Natural | null,
): React.CSSProperties {
  const width = Math.min(scale, 100);
  // Height as a share of the frame: the watermark's own aspect ratio, measured
  // against a frame that is FRAME_ASPECT times wider than it is tall.
  const height = natural
    ? Math.min(100, width * (natural.height / natural.width) * FRAME_ASPECT)
    : width;

  return {
    width: `${width}%`,
    left: `${((100 - width) * x) / 100}%`,
    top: `${((100 - height) * y) / 100}%`,
  };
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  suffix = '%',
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={`${label} — ${value}${suffix}`} hint={hint}>
      <input
        type="range"
        className="w-full accent-sky-500"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}

export function WatermarkPanel({ status, onSaved }: { status: Status; onSaved: () => void }) {
  const { watermark } = status.settings;
  const [enabled, setEnabled] = useState(watermark.enabled);
  const [required, setRequired] = useState(watermark.required);
  const [x, setX] = useState(watermark.x);
  const [y, setY] = useState(watermark.y);
  const [opacity, setOpacity] = useState(watermark.opacity);
  const [scale, setScale] = useState(watermark.scale);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<Natural | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setEnabled(watermark.enabled), [watermark.enabled]);
  useEffect(() => setRequired(watermark.required), [watermark.required]);
  useEffect(() => setX(watermark.x), [watermark.x]);
  useEffect(() => setY(watermark.y), [watermark.y]);
  useEffect(() => setOpacity(watermark.opacity), [watermark.opacity]);
  useEffect(() => setScale(watermark.scale), [watermark.scale]);

  // The PNG comes down as a blob because the API wants an auth header that an
  // <img src> cannot send; the object URL has to be handed back afterwards.
  // `imageStamp` moves when the file is replaced, which `hasImage` alone does
  // not — without it a replacement would leave the old logo on screen.
  useEffect(() => {
    if (!watermark.hasImage) {
      setImageUrl(null);
      setNatural(null);
      return;
    }

    let url: string | null = null;
    let cancelled = false;

    void apiClient
      .watermarkImageUrl()
      .then((next) => {
        if (cancelled) {
          if (next) URL.revokeObjectURL(next);
          return;
        }
        url = next;
        setImageUrl(next);
      })
      .catch(() => setImageUrl(null));

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [watermark.hasImage, watermark.imageStamp]);

  async function upload(file: File) {
    setBusy(true);
    setMessage(null);
    try {
      await apiClient.uploadWatermark(file);
      setMessage({ tone: 'ok', text: 'Watermark uploaded.' });
      onSaved();
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Upload failed' });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    setMessage(null);
    try {
      await apiClient.removeWatermark();
      setMessage({ tone: 'ok', text: 'Watermark removed.' });
      onSaved();
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Remove failed' });
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await apiClient.saveSettings({
        watermarkEnabled: enabled,
        watermarkRequired: required,
        watermarkX: x,
        watermarkY: y,
        watermarkOpacity: opacity,
        watermarkScale: scale,
      });
      setMessage({ tone: 'ok', text: 'Saved.' });
      onSaved();
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Watermark">
      <form className="grid gap-5 lg:grid-cols-2" onSubmit={save}>
        <div className="grid content-start gap-4">
          <Check
            label="Stamp every image and video before posting"
            hint="Applied when the post is sent to the bot, so what sits in the queue is already watermarked."
            checked={enabled}
            onChange={setEnabled}
          />

          <Field
            label="Watermark PNG"
            hint={
              watermark.hasImage
                ? 'Replace it by choosing another file. PNG only — transparency is the point.'
                : 'PNG only, up to 2 MB. Nothing is stamped until one is uploaded.'
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/png"
                disabled={busy}
                className="w-full text-sm text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-200 hover:file:bg-slate-700"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              {watermark.hasImage && (
                <Button type="button" variant="danger" disabled={busy} onClick={() => void remove()}>
                  Remove watermark
                </Button>
              )}
            </div>
          </Field>

          <Slider
            label="Horizontal"
            hint="0 is the left edge, 50 centres it, 100 is the right edge."
            value={x}
            min={0}
            max={100}
            onChange={setX}
          />
          <Slider
            label="Vertical"
            hint="0 is the top edge, 50 centres it, 100 is the bottom edge."
            value={y}
            min={0}
            max={100}
            onChange={setY}
          />
          <Slider
            label="Opacity"
            hint="Applied on top of the PNG's own transparency."
            value={opacity}
            min={1}
            max={100}
            onChange={setOpacity}
          />
          <Slider
            label="Size"
            hint="Width as a share of the picture's width, so it looks the same on a photo and on a 1080p video."
            value={scale}
            min={1}
            max={100}
            onChange={setScale}
          />

          <Check
            label="Refuse anything that cannot be watermarked"
            hint="Media over 20 MB is more than a bot may download, so it cannot be stamped. Off: it is queued unstamped and the sender is told. On: nothing is queued."
            checked={required}
            onChange={setRequired}
          />
        </div>

        <div className="grid content-start gap-3">
          <span className="block text-xs font-medium tracking-wide text-slate-400 uppercase">
            Preview
          </span>
          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-slate-800 bg-[repeating-conic-gradient(#1e293b_0_25%,#0f172a_0_50%)] bg-[length:24px_24px]">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt="Watermark preview"
                className="absolute"
                style={{ ...placementStyle(x, y, scale, natural), opacity: opacity / 100 }}
                onLoad={(event) =>
                  setNatural({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
              />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-slate-500">
                Upload a PNG to see where it lands.
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">
            A 16:9 frame, to scale. The watermark can never hang over an edge — the percentages
            move it through the room it has left, so 100 / 100 is the bottom-right corner with the
            whole logo still on the picture.
          </p>
          {enabled && !watermark.hasImage && (
            <p className="rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              Watermarking is on, but no PNG is uploaded — posts go out unstamped until there is
              one.
            </p>
          )}
          {enabled && status.tools.ffmpeg.error && (
            <p className="rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              ffmpeg: {status.tools.ffmpeg.error} Nothing can be stamped without it.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 lg:col-span-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save watermark'}
          </Button>
          {message && (
            <span
              className={message.tone === 'ok' ? 'text-sm text-emerald-400' : 'text-sm text-rose-400'}
            >
              {message.text}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
