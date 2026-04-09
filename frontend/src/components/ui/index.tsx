// ─── Shared UI building blocks ────────────────────────────

import type { ReactNode } from 'react';

// ── PageHeader ───────────────────────────────────────────
interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  breadcrumb?: { label: string; href?: string }[];
}

export function PageHeader({ title, subtitle, action, breadcrumb }: PageHeaderProps) {
  return (
    <div className="px-6 py-4 flex items-center justify-between sticky top-0 z-10"
      style={{ background: '#1e1e1e', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
      <div>
        {breadcrumb && (
          <nav className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
            {breadcrumb.map((b, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span>›</span>}
                {b.href
                  ? <a href={b.href} className="text-gold-500 hover:underline">{b.label}</a>
                  : <span className={i === breadcrumb.length - 1 ? 'text-gray-200 font-medium' : ''}>{b.label}</span>
                }
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-base font-semibold text-white">{title}</h1>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

// ── StatCard ─────────────────────────────────────────────
interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  subColor?: 'red' | 'green' | 'neutral';
}

export function StatCard({ label, value, sub, subColor = 'neutral' }: StatCardProps) {
  const subClass = subColor === 'red' ? 'text-red-400' : subColor === 'green' ? 'text-emerald-400' : 'text-gray-500';
  return (
    <div className="stat-card">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-xl font-semibold text-white leading-none">{value}</p>
      {sub && <p className={`text-xs mt-1 ${subClass}`}>{sub}</p>}
    </div>
  );
}

// ── Badge / Pill ─────────────────────────────────────────
interface PillProps {
  children: ReactNode;
  color?: 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'purple';
}

export function Pill({ children, color = 'gray' }: PillProps) {
  return <span className={`pill pill-${color}`}>{children}</span>;
}

// ── StatusDot ────────────────────────────────────────────
export function StatusDot({ status }: { status: 'success' | 'warning' | 'error' | 'pending' }) {
  const colors = {
    success: 'bg-emerald-500',
    warning: 'bg-amber-400',
    error: 'bg-red-500',
    pending: 'bg-gray-600',
  };
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${colors[status]}`} />;
}

// ── InsightCard ──────────────────────────────────────────
import type { AIInsight } from '../../types';
import { SEVERITY_PILL } from '../../types';

interface InsightCardProps {
  insight: AIInsight;
  onRead?: (id: string) => void;
  onDismiss?: (id: string) => void;
}

export function InsightCard({ insight, onRead, onDismiss }: InsightCardProps) {
  const borderColor = insight.severity === 'ALERT'
    ? 'border-l-red-500'
    : insight.severity === 'WARNING'
    ? 'border-l-amber-400'
    : 'border-l-blue-500';

  const bgOverlay = insight.isRead ? '' : 'bg-white/[0.02]';

  return (
    <div className={`card border-l-4 ${borderColor} ${bgOverlay} p-4 mb-3`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <p className="text-sm font-medium text-white">{insight.title}</p>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Pill color={
            insight.severity === 'ALERT' ? 'red' :
            insight.severity === 'WARNING' ? 'amber' : 'blue'
          }>
            {insight.severity === 'ALERT' ? 'Alert' : insight.severity === 'WARNING' ? 'Warning' : 'Info'}
          </Pill>
          {onDismiss && (
            <button
              onClick={() => onDismiss(insight.id)}
              className="text-xs text-gray-600 hover:text-gray-400"
            >✕</button>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-400 leading-relaxed mb-2">{insight.body}</p>
      {insight.recommendation && (
        <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.05)' }}>
          <p className="text-xs font-medium text-gold-500 uppercase tracking-wide mb-0.5">Recommendation</p>
          <p className="text-xs text-gray-300">{insight.recommendation}</p>
          {insight.potentialSavings && (
            <p className="text-sm font-semibold text-emerald-400 mt-1">
              ~${Number(insight.potentialSavings).toFixed(0)}/yr potential savings
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between mt-2">
        <p className="text-xs text-gray-500">
          {insight.property?.address || insight.property?.nickname}
          {insight.utilityAccount ? ` · ${insight.utilityAccount.providerName}` : ''}
        </p>
        {!insight.isRead && onRead && (
          <button onClick={() => onRead(insight.id)} className="text-xs text-gold-500 hover:underline">
            Mark read
          </button>
        )}
      </div>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────
export function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-4xl mb-3">{icon}</div>
      <p className="text-sm font-medium text-gray-300 mb-1">{title}</p>
      <p className="text-xs text-gray-500 max-w-xs">{body}</p>
    </div>
  );
}

// ── Loading skeleton ─────────────────────────────────────
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded ${className}`} style={{ background: 'rgba(255,255,255,0.06)' }} />;
}

// ── Modal wrapper ────────────────────────────────────────
interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ title, onClose, children, footer }: ModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="rounded-xl shadow-2xl w-full max-w-lg mx-4" style={{ background: '#2a2a2a', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="px-5 py-3 flex items-center justify-end gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Form field ───────────────────────────────────────────
interface FieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  children: ReactNode;
  hint?: string;
}

export function Field({ label, htmlFor, required, children, hint }: FieldProps) {
  return (
    <div className="mb-4">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-gray-300 mb-1">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

export function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg px-3 py-2 text-sm text-gray-100
                  placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-gold-500
                  focus:border-transparent ${className}`}
      style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)' }}
      {...props}
    />
  );
}

export function Select({ className = '', ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-lg px-3 py-2 text-sm text-gray-100
                  focus:outline-none focus:ring-2 focus:ring-gold-500 ${className}`}
      style={{ background: '#2a2a2a', border: '1px solid rgba(255,255,255,0.1)' }}
      {...props}
    />
  );
}
