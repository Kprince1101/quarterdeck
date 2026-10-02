import { useState } from 'react';

export interface ConfirmStep {
  isConfirming: boolean;
  isAsking: boolean;
  handleAsk: () => void;
  handleCancel: () => void;
  settle: () => void;
}

export const useConfirm = (): ConfirmStep => {
  const [isConfirming, setConfirming] = useState(false);
  const settle = () => {
    setConfirming(false);
  };
  return {
    isConfirming,
    isAsking: !isConfirming,
    handleAsk: () => {
      setConfirming(true);
    },
    handleCancel: settle,
    settle,
  };
};
