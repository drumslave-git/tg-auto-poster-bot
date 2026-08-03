import { useState } from 'react';
import { setPassword } from '../api';
import { Button, Field, inputClass } from './ui';

export function PasswordGate({ onSubmit }: { onSubmit: () => void }) {
  const [value, setValue] = useState('');

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form
        className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/60 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          setPassword(value.trim());
          onSubmit();
        }}
      >
        <h1 className="mb-1 text-lg font-semibold text-slate-100">Dashboard locked</h1>
        <p className="mb-4 text-sm text-slate-400">Enter the DASHBOARD_PASSWORD from the server.</p>
        <Field label="Password">
          <input
            className={inputClass}
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" className="mt-4 w-full">
          Unlock
        </Button>
      </form>
    </div>
  );
}
