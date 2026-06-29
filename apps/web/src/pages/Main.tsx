import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Requirement } from '@po/core';
import { useProject, useRequirements, useDeleteRequirement } from '../api/hooks';
import { projectsApi, type ArchiveFormat } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { useUiStore } from '../store/ui';
import { childCountOf } from '../lib/tree';
import { PathHeader } from '../components/PathHeader';
import { TreeTable } from '../components/TreeTable';
import { RequirementModal } from '../components/RequirementModal';
import { LinkModal } from '../components/LinkModal';
import { ConfirmDialog } from '../components/ConfirmDialog';

export function Main(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const projectQuery = useProject(id);
  const reqQuery = useRequirements(id);
  const modal = useUiStore((s) => s.modal);
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);

  const deleteMut = useDeleteRequirement(id);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const requirements = reqQuery.data?.requirements ?? [];
  const functional = requirements.filter((r) => r.type === 'FUNCTION');
  const nfr = requirements.filter((r) => r.type === 'NFR');

  const onExport = async (format: ArchiveFormat): Promise<void> => {
    setExportError(null);
    try {
      const { blob, filename } = await projectsApi.export(id, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(errorMessage(err));
    }
  };

  const onEdit = (req: Requirement): void =>
    openModal({ kind: 'requirement', reqType: req.type, requirement: req });
  const onLink = (req: Requirement): void => openModal({ kind: 'link', source: req });
  const onDelete = (req: Requirement): void => {
    setDeleteError(null);
    openModal({ kind: 'delete', requirement: req });
  };

  return (
    <div className="flex min-h-screen flex-col" data-testid="main-page">
      <PathHeader name={projectQuery.data?.name ?? id} mainPath={projectQuery.data?.mainPath ?? ''} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {reqQuery.isLoading ? (
          <p data-testid="main-loading" style={{ color: 'var(--color-text-3)' }}>
            Загрузка требований…
          </p>
        ) : reqQuery.isError ? (
          <p
            className="rounded-lg p-3 text-sm"
            role="alert"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}
            data-testid="main-error"
          >
            {errorMessage(reqQuery.error)}
          </p>
        ) : (
          <>
            <TreeTable
              title="Функциональные требования"
              addLabel="+ Функция"
              testidPrefix="function"
              requirements={functional}
              onAdd={() => openModal({ kind: 'requirement', reqType: 'FUNCTION' })}
              onEdit={onEdit}
              onLink={onLink}
              onDelete={onDelete}
            />
            <TreeTable
              title="Нефункциональные требования"
              addLabel="+ НФТ"
              testidPrefix="nfr"
              requirements={nfr}
              onAdd={() => openModal({ kind: 'requirement', reqType: 'NFR' })}
              onEdit={onEdit}
              onLink={onLink}
              onDelete={onDelete}
            />
          </>
        )}
      </main>

      <footer
        className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3"
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        data-testid="main-footer"
      >
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-primary text-sm"
            data-testid="footer-add-function"
            onClick={() => openModal({ kind: 'requirement', reqType: 'FUNCTION' })}
          >
            + Функция
          </button>
          <button
            type="button"
            className="btn btn-secondary text-sm"
            data-testid="footer-add-nfr"
            onClick={() => openModal({ kind: 'requirement', reqType: 'NFR' })}
          >
            + НФТ
          </button>
        </div>
        <div className="flex items-center gap-2">
          {exportError ? (
            <span className="text-xs" role="alert" style={{ color: 'var(--color-danger)' }} data-testid="export-error">
              {exportError}
            </span>
          ) : null}
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            Экспорт:
          </span>
          <button type="button" className="btn btn-secondary text-sm" data-testid="export-zip" onClick={() => void onExport('zip')}>
            .zip
          </button>
          <button type="button" className="btn btn-secondary text-sm" data-testid="export-targz" onClick={() => void onExport('targz')}>
            .tar.gz
          </button>
        </div>
      </footer>

      {modal?.kind === 'requirement' ? (
        <RequirementModal
          projectId={id}
          reqType={modal.reqType}
          requirement={modal.requirement}
          onClose={closeModal}
        />
      ) : null}

      {modal?.kind === 'link' ? (
        <LinkModal projectId={id} source={modal.source} requirements={requirements} onClose={closeModal} />
      ) : null}

      {modal?.kind === 'delete'
        ? (() => {
            const req = modal.requirement;
            const children = childCountOf(req);
            const note =
              children > 0
                ? {
                    tone: 'danger' as const,
                    text: `У требования есть ${children} дочерних элемент(ов). Сначала удалите или перепривяжите их.`,
                  }
                : {
                    tone: 'warning' as const,
                    text: 'У требования нет дочерних элементов — удаление безопасно.',
                  };
            return (
              <ConfirmDialog
                testid="delete-dialog"
                danger
                title="Точно удалить требование?"
                message={`«${req.name}» будет удалено безвозвратно. Все связи с другими требованиями также будут удалены.`}
                note={note}
                error={deleteError}
                confirmLabel="Удалить"
                busy={deleteMut.isPending}
                onCancel={closeModal}
                onConfirm={async () => {
                  setDeleteError(null);
                  try {
                    await deleteMut.mutateAsync(req.id);
                    closeModal();
                  } catch (err) {
                    if (err instanceof ApiError && err.code === 'HAS_CHILDREN') {
                      setDeleteError('Нельзя удалить требование с дочерними элементами.');
                    } else {
                      setDeleteError(errorMessage(err));
                    }
                  }
                }}
              />
            );
          })()
        : null}
    </div>
  );
}
