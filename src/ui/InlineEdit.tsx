import { useEffect, useRef, useState } from 'react';

interface Props {
  value: string;
  placeholder?: string;
  className?: string;
  /** null = anulowano (Escape) */
  onDone: (value: string | null) => void;
}

/** Pole do szybkiej zmiany nazwy: Enter/klik obok zapisuje, Escape anuluje. */
export function InlineEdit({ value, placeholder, className, onDone }: Props) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };

  return (
    <input
      ref={ref}
      className={'inline-edit ' + (className ?? '')}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(v);
        if (e.key === 'Escape') finish(null);
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
