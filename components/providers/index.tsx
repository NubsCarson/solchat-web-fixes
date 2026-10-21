'use client';

import { ReactNode } from 'react';
import {VoiceCallProviderWrapper} from '@/components/voice/VoiceCallProviderWrapper';
import { ReactQueryProvider } from './query-provider';
import {  ThemeProvider } from 'styled-components';
import { PrivyProvider } from './privy-provider';
import { SolanaWalletProvider } from './wallet-provider';
import { AppConnectionProvider } from '@/lib/wallet/app-connection';
import { CacheProvider } from './cache-provider';
import { StyledComponentsRegistry } from './styled-components-registry';
import solchatTheme from '../styles/solchatTheme'
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <StyledComponentsRegistry>
      <ThemeProvider theme={solchatTheme}>
        <CacheProvider>
          <SolanaWalletProvider>
            <PrivyProvider>
              <AppConnectionProvider>
                <ReactQueryProvider><VoiceCallProviderWrapper>{children}</VoiceCallProviderWrapper></ReactQueryProvider>
              </AppConnectionProvider>
            </PrivyProvider>
          </SolanaWalletProvider>
        </CacheProvider>
      </ThemeProvider>
    </StyledComponentsRegistry>
  );
}
