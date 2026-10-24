// TRUST PACK (pipeline item 5, Renato 10-24, 3. a and 4. a): the "Who we
// are" section on the About page. Nothing about a real person is
// written here until that person has sent their own words: the name to
// show, a role, and one or two sentences. Until then the list is empty
// and the section doesn't render.
export type TeamMember = {
  name: string;
  role: string;
  bio: string;
};

export const TEAM: TeamMember[] = [];

// A member with any empty field is left out, so a half-filled entry
// never shows as a blank line.
export function visibleTeam(team: TeamMember[] = TEAM): TeamMember[] {
  return team.filter((member) => [member.name, member.role, member.bio].every((value) => value.trim() !== ""));
}
