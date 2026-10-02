export class StoreConnectionLostError extends Error {
  readonly location: string;

  constructor(location: string, options?: ErrorOptions) {
    super(
      `Lost the Postgres session at ${location}; the project lock and LISTEN went with it, so this store is closed. Restart to reopen it.`,
      options,
    );
    this.name = 'StoreConnectionLostError';
    this.location = location;
  }
}

export class ProjectOpenError extends Error {
  readonly project: string;

  constructor(project: string) {
    super(
      `project ${project} is already open by another connection to this database`,
    );
    this.name = 'ProjectOpenError';
    this.project = project;
  }
}
