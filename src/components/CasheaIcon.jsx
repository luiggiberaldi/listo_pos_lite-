/**
 * CasheaIcon — Logo oficial de Cashea
 * Técnica: arco de stroke sobre círculo, evita ambigüedad de path
 *
 * Geometría:
 *   - Círculo SVG r=48, borde negro 4px
 *   - C: r=29 (mid), strokeWidth=20 → outer edge=39, inner edge=19
 *   - Gap: 100° centrado en 3 en punto (derecha)
 *   - Arco: 260° desde ~4:40 (SVG 50°) sentido horario hasta ~1:20 (SVG 310°)
 *   - rotate(50°) mueve el inicio del stroke a SVG 50° (4:40 reloj)
 *   - strokeDasharray = arc(260°) + gap(100°)
 */
export default function CasheaIcon({ size = 20, className = '' }) {
    const r = 29;
    const circumference = 2 * Math.PI * r; // ~182.2
    const arcDeg = 260;
    const arcLen = (arcDeg / 360) * circumference; // ~131.6
    const gapLen = circumference - arcLen;           // ~50.6

    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 100 100"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
        >
            {/* Círculo amarillo con borde negro */}
            <circle cx="50" cy="50" r="48" fill="#FFE600" stroke="#111111" strokeWidth="4" />

            {/* C: arco de stroke, rotado para centrar gap en 3 en punto */}
            <circle
                cx="50" cy="50"
                r={r}
                fill="none"
                stroke="#111111"
                strokeWidth="20"
                strokeLinecap="butt"
                strokeDasharray={`${arcLen.toFixed(2)} ${gapLen.toFixed(2)}`}
                transform="rotate(50, 50, 50)"
            />
        </svg>
    );
}
