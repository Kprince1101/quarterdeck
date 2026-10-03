import { useEffect, useState, type ChangeEvent } from 'react';
import type { ServicesReadResult } from '@quarterdeck/server/intents';
import { valueOf } from '../../grid/dom.js';
import {
  EMPTY_SERVICES_FORM,
  formOf,
  isHowChoice,
  type ServicesForm,
} from './services-form.js';

type TextField = 'kind' | 'reach' | 'notes';

type TextChange = (
  event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
) => void;

export interface ServicesFormState {
  form: ServicesForm;
  handleKindChange: TextChange;
  handleReachChange: TextChange;
  handleNotesChange: TextChange;
  handleHowChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  handlePublishesChange: () => void;
}

export const useServicesForm = (
  read: ServicesReadResult | null,
): ServicesFormState => {
  const [form, setForm] = useState<ServicesForm>(EMPTY_SERVICES_FORM);

  useEffect(() => {
    if (read !== null) setForm(formOf(read));
  }, [read]);

  const textChange =
    (field: TextField): TextChange =>
    (event) => {
      const value = valueOf(event.currentTarget);
      setForm((current) => ({ ...current, [field]: value }));
    };

  return {
    form,
    handleKindChange: textChange('kind'),
    handleReachChange: textChange('reach'),
    handleNotesChange: textChange('notes'),
    handleHowChange: (event) => {
      const how = valueOf(event.currentTarget);
      if (!isHowChoice(how)) return;
      setForm((current) => ({ ...current, how }));
    },
    handlePublishesChange: () => {
      setForm((current) => ({ ...current, publishes: !current.publishes }));
    },
  };
};
