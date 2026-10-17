import type { ReactNode } from 'react';

const paths = {
  review: (
    <>
      <path d="M3 15V7.2A3 3 0 0 1 8.1 5.1l2.1 2.1a2.4 2.4 0 0 0 3.6 0l2.1-2.1A3 3 0 0 1 21 7.2V15a4.8 4.8 0 0 1-4.8 4.8H7.8A4.8 4.8 0 0 1 3 15Z" />
      <rect x="6.3" y="9.6" width="3" height="5.4" rx="1.5" fill="currentColor" stroke="none" />
      <rect x="14.7" y="9.6" width="3" height="5.4" rx="1.5" fill="currentColor" stroke="none" />
      <rect
        x="10.2"
        y="15.6"
        width="3.6"
        height="1.8"
        rx="0.9"
        fill="currentColor"
        stroke="none"
        opacity="0.4"
      />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.73v.5a2 2 0 0 1-1 1.73l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.73v-.5a2 2 0 0 1 1-1.73l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10m12-10c0 6-12 2-12 8" />
    </>
  ),
  chat: <path d="M20 16a2 2 0 0 1-2 2H8l-5 3V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z" />,
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6" />
      <path d="M8 13h8m-8 4h5" />
    </>
  ),
  history: (
    <>
      <path d="M3 3v5h5M3 8a9 9 0 1 1-1 8" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  send: (
    <>
      <path d="m12 19 0-14m-6 6 6-6 6 6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
  open: (
    <>
      <path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`size-4 shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
