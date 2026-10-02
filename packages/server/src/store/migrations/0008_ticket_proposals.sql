alter table tickets drop constraint tickets_status_check;

alter table tickets add constraint tickets_status_check
  check (status in (
    'proposed', 'open', 'assigned', 'in_progress', 'in_review', 'bounced',
    'done', 'cancelled', 'rejected'
  ));
