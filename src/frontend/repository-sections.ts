import type { RepositorySettings } from "../shared/repositories";

export interface RepositoryView {
  readonly settings: RepositorySettings;
  readonly monitoringAtLoad: ReadonlyMap<number, boolean>;
}

/** Keep existing rows in place on settings rereads; omit previous to regroup. */
export function repositoryView(settings: RepositorySettings, previous?: RepositoryView | null): RepositoryView {
  return {
    settings,
    monitoringAtLoad: new Map(settings.repositories.map((repository) => [
      repository.id, previous?.monitoringAtLoad.get(repository.id) ?? repository.monitored,
    ])),
  };
}
