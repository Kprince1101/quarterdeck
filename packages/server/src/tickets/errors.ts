export class TicketSourceInputError extends Error {
  readonly source: string;

  constructor(source: string, operation: string, reason: string) {
    super(`Ticket source ${source} refused ${operation}: ${reason}`);
    this.name = 'TicketSourceInputError';
    this.source = source;
  }
}

export class TicketSourceError extends Error {
  readonly source: string;
  readonly operation: string;

  constructor(
    source: string,
    operation: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`Ticket source ${source} failed ${operation}: ${reason}`, options);
    this.name = 'TicketSourceError';
    this.source = source;
    this.operation = operation;
  }
}

export class TicketSourcePluginError extends Error {
  readonly plugin: string;

  constructor(plugin: string, reason: string, options?: ErrorOptions) {
    super(
      `Ticket-source plugin ${plugin} cannot be loaded: ${reason}`,
      options,
    );
    this.name = 'TicketSourcePluginError';
    this.plugin = plugin;
  }
}

export class TicketNotFoundError extends Error {
  readonly ref: string;

  constructor(ref: string) {
    super(`No ticket ${ref} in this project`);
    this.name = 'TicketNotFoundError';
    this.ref = ref;
  }
}
