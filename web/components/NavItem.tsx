"use client";

import Link from "next/link";

export type NavItemProps = {
  href?: string;
  isActive: boolean;
  title: string;
  icon: React.ReactNode;
  disabled?: boolean;
  comingSoon?: boolean;
};

export default function NavItem({ 
  href, 
  isActive, 
  title, 
  icon, 
  disabled = false, 
  comingSoon = false 
}: NavItemProps) {
  const navItemBaseClasses = "flex items-center justify-center w-10 h-10 rounded-md transition-colors duration-200 relative";
  const navItemActiveClasses = "text-white";
  const navItemInactiveClasses = disabled ? "text-gray-400 cursor-not-allowed" : "text-foreground hover:text-gray-600";
  
  const content = (
    <>
      {isActive && <div className="absolute inset-0 bg-purple-800 rounded-md"></div>}
      <div className="relative z-10">{icon}</div>
      {comingSoon && (
        <span className="absolute -bottom-8 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white text-xs py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap pointer-events-none">
          Coming Soon
        </span>
      )}
    </>
  );

  if (disabled) {
    return (
      <div
        className={`${navItemBaseClasses} ${isActive ? navItemActiveClasses : navItemInactiveClasses} group`}
        title={title}
      >
        {content}
      </div>
    );
  }

  return (
    <Link
      href={href || "#"}
      className={`${navItemBaseClasses} ${isActive ? navItemActiveClasses : navItemInactiveClasses}`}
      title={title}
    >
      {content}
    </Link>
  );
} 