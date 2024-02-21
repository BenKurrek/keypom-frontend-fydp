import { type AccountState, type WalletSelector } from '@near-wallet-selector/core';
import { Heading } from '@chakra-ui/react';
import { providers } from 'near-api-js';
import { type AccountView } from 'near-api-js/lib/providers/provider';
import { type WalletSelectorModal } from '@near-wallet-selector/modal-ui';
import { useInitNear } from 'near-social-vm';
import { Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

import { NearWalletSelector } from '@/lib/walletSelector';

declare global {
  interface Window {
    selector: WalletSelector;
    modal: WalletSelectorModal;
  }
}

type Account = AccountView & {
  account_id: string;
};

interface AuthWalletContextValues {
  modal: WalletSelectorModal;
  selector: WalletSelector;
  accounts: AccountState[];
  accountId: string | null;
  isLoggedIn: boolean;
  account: Account;
}

const AuthWalletContext = createContext<AuthWalletContextValues | null>(null);

export const AuthWalletContextProvider = ({ children }: PropsWithChildren) => {
  const { initNear } = useInitNear();
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accounts, setAccounts] = useState<AccountState[]>([]);
  const [account, setAccount] = useState<Account | null>(null);

  const accountId = accounts.find((account) => account.active)?.accountId ?? null;

  const getAccount = useCallback(async (): Promise<Account | null> => {
    if (!accountId) {
      return null;
    }

    const provider = new providers.JsonRpcProvider({
      url: selector?.options?.network.nodeUrl ?? '',
    });

    return await provider
      .query<AccountView>({
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      })
      .then((data) => ({
        ...data,
        account_id: accountId,
      }));
  }, [accountId, selector?.options]);

  useEffect(() => {
    const initWalletSelector = async () => {
      const walletSelector = new NearWalletSelector();
      initNear &&
        (await initNear({
          networkId: 'mainnet',
          selector: walletSelector,
          customElements: {
            Heading: () => <Heading />,
            MUIDialog: (props) => <Dialog {...props} />,
            MUIDialogTitle: () => <DialogTitle />,
            MUIDialogContent: () => <DialogContent />,
            MUIDialogActions: () => <DialogActions />,
          },
        }));
      await walletSelector.init();

      setModal(walletSelector.modal);
      setSelector(walletSelector.selector);
      setAccounts(walletSelector.accounts);

      if (typeof window !== undefined) {
        window.modal = walletSelector.modal;
        window.selector = walletSelector.selector;
      }
    };

    initWalletSelector().catch(console.error); // eslint-disable-line no-console
  }, [initNear]);

  // set account
  useEffect(() => {
    if (!accountId) {
      setAccount(null);
      return;
    }

    // setLoading(true);

    getAccount()
      .then((nextAccount) => {
        sessionStorage.setItem('account', JSON.stringify(nextAccount));
        setAccount(nextAccount);
        // setLoading(false);
      })
      .catch(console.error); // eslint-disable-line no-console
  }, [accountId, getAccount]);

  const value = {
    modal: modal as WalletSelectorModal,
    selector: selector as WalletSelector,
    accounts,
    accountId,
    isLoggedIn: Boolean(sessionStorage.getItem('account')), // selector?.isSignedIn(), with null, cant login. with undefined, cant signout properly
    account: account as Account,
  };

  return <AuthWalletContext.Provider value={value}>{children}</AuthWalletContext.Provider>;
};

export const useAuthWalletContext = () => {
  const context = useContext(AuthWalletContext);

  if (context === null) {
    throw new Error('useAuthWalletContext must be used within a AuthWalletContextProvider');
  }

  return context;
};
