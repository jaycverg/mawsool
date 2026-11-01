'use client';

import qrcode from 'qrcode-generator';

/** A QR code drawn as SVG from the ticket's payload, so reception can scan it. Drawn on the phone; nothing is fetched. */
export function QrCode({ payload, label }: { payload: string; label: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();
  const size = qr.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < size; row += 1) for (let col = 0; col < size; col += 1) if (qr.isDark(row, col)) cells.push(`M${col} ${row}h1v1h-1z`);
  return (
    <svg width="84" height="84" viewBox={`-2 -2 ${size + 4} ${size + 4}`} role="img" aria-label={label} className="box-content shrink-0 rounded-[8px] bg-surface p-1" data-qr>
      <path d={cells.join('')} fill="#10302D" shapeRendering="crispEdges" />
    </svg>
  );
}
