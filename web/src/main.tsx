import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

// Self-hosted variable fonts — the three families tokens.css asks for.
import '@fontsource-variable/inter'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/jetbrains-mono'

// Tokens first, then the base layer, then everything else (CSS modules).
import '@/design/tokens.css'
import '@/design/base.css'

import { router } from '@/router'
import { createQueryClient } from '@/core/queries'

// Paint the right palette before React mounts (the shell keeps it in sync).
document.documentElement.dataset.role ||= 'none'

const queryClient = createQueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
