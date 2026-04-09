/**
 * BsIcon — Bolívares: círculo azul con "Bs" en blanco
 */
export function BsIcon({ size = 20, className = '' }) {
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
            <circle cx="50" cy="50" r="50" fill="#2F80ED" />
            <text
                x="50"
                y="56"
                textAnchor="middle"
                dominantBaseline="middle"
                fill="white"
                fontSize="38"
                fontWeight="bold"
                fontFamily="Arial, sans-serif"
                letterSpacing="-1"
            >Bs</text>
        </svg>
    );
}

/**
 * UsdIcon — Dólares: círculo verde con "$" en blanco
 */
export function UsdIcon({ size = 20, className = '' }) {
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
            <circle cx="50" cy="50" r="50" fill="#4CAF50" />
            <text
                x="50"
                y="56"
                textAnchor="middle"
                dominantBaseline="middle"
                fill="white"
                fontSize="52"
                fontWeight="bold"
                fontFamily="Arial, sans-serif"
            >$</text>
        </svg>
    );
}
