import { useQuery } from '@tanstack/react-query';
import type { RequirementType } from '@po/core';
import { requirementsApi } from '../api/endpoints';
import { useDebounce } from '../lib/useDebounce';

export interface NameCheck {
  /** The trimmed name is taken by another requirement of the same type. */
  nameTaken: boolean;
  /** The trimmed name is confirmed unique. */
  nameOk: boolean;
}

/**
 * BE-5: real-time name-uniqueness check (FR-6.6), extracted from
 * RequirementModal. Debounces the input and queries `check-name`, excluding the
 * requirement being edited so its own name never reads as a duplicate.
 */
export function useNameCheck(
  projectId: string,
  reqType: RequirementType,
  name: string,
  excludeSlug?: string,
): NameCheck {
  const debouncedName = useDebounce(name.trim(), 350);
  const query = useQuery({
    queryKey: ['checkName', projectId, reqType, debouncedName, excludeSlug ?? null],
    queryFn: () => requirementsApi.checkName(projectId, reqType, debouncedName, excludeSlug),
    enabled: debouncedName.length > 0,
  });
  return {
    nameTaken: query.data?.available === false,
    nameOk: query.data?.available === true,
  };
}
