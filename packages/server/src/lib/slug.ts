export const PROJECT_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const assertProjectSlug = (project: string): string => {
  if (!PROJECT_SLUG.test(project)) {
    throw new Error(`Invalid project slug: ${JSON.stringify(project)}`);
  }
  return project;
};
