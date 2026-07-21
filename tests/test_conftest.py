"""Unit tests for `conftest.py`'s per-worktree test-database suffixing (INFRA-1). Pure
filesystem logic — no DB needed, unlike everything else `conftest.py` provides."""

from conftest import _worktree_test_db_suffix


def test_main_checkout_is_unsuffixed(tmp_path):
    (tmp_path / '.git').mkdir()
    assert _worktree_test_db_suffix(tmp_path) is None


def test_linked_worktree_suffix_from_gitdir_name(tmp_path):
    (tmp_path / '.git').write_text(
        'gitdir: /home/x/main-repo/.git/worktrees/todo+SAVE-1\n')
    assert _worktree_test_db_suffix(tmp_path) == 'todo_save_1'


def test_no_git_found_anywhere(tmp_path):
    nested = tmp_path / 'a' / 'b'
    nested.mkdir(parents=True)
    assert _worktree_test_db_suffix(nested) is None


def test_walks_up_from_a_subdirectory(tmp_path):
    (tmp_path / '.git').write_text('gitdir: /home/x/main-repo/.git/worktrees/SAVE-1\n')
    nested = tmp_path / 'netbox-facilitymap' / 'tests'
    nested.mkdir(parents=True)
    assert _worktree_test_db_suffix(nested) == 'save_1'


def test_malformed_git_file_is_ignored(tmp_path):
    (tmp_path / '.git').write_text('not a gitdir line\n')
    assert _worktree_test_db_suffix(tmp_path) is None
