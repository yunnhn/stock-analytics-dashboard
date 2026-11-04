import React from 'react';

// Kartu dasar dashboard: judul + garis pemisah, warna diatur lewat className/style
const BentoCard = ({ children, className = "", style, title, action }) => (
    <div className={`rounded-2xl border p-5 shadow-lg ${className}`} style={style}>
        {title && (
            <div className="flex items-center justify-between gap-3 pb-3 mb-4 border-b border-white/10">
                <h3 className="text-base font-semibold text-white">{title}</h3>
                {action}
            </div>
        )}
        {children}
    </div>
);

export default BentoCard;
