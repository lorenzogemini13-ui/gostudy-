document.addEventListener('DOMContentLoaded', () => {
    // Reveal Animations
    const revealElements = document.querySelectorAll('.reveal');
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if(entry.isIntersecting){
          entry.target.classList.add('active');
        }
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -50px 0px" });
    revealElements.forEach(el => revealObserver.observe(el));

    // Mobile Menu Logic
    const mobileBtn = document.getElementById('mobile-menu-btn');
    const mobileClose = document.getElementById('mobile-menu-close');
    const mobileMenu = document.getElementById('mobile-menu');

    function toggleMenu() {
        if (!mobileMenu) return;
        const isHidden = mobileMenu.classList.contains('hidden');
        if (isHidden) {
            mobileMenu.classList.remove('hidden');
            setTimeout(() => {
                mobileMenu.classList.remove('opacity-0', 'pointer-events-none');
            }, 10);
            document.body.style.overflow = 'hidden';
        } else {
            mobileMenu.classList.add('opacity-0', 'pointer-events-none');
            setTimeout(() => {
                mobileMenu.classList.add('hidden');
            }, 300);
            document.body.style.overflow = '';
        }
    }

    if(mobileBtn) mobileBtn.addEventListener('click', toggleMenu);
    if(mobileClose) mobileClose.addEventListener('click', toggleMenu);

    // Navbar scroll effect
    window.addEventListener('scroll', () => {
        const header = document.getElementById('main-header');
        if (!header) return;
        if (window.scrollY > 20) {
            header.classList.remove('bg-white/80', 'border-white/20');
            header.classList.add('bg-white/95', 'shadow-sm', 'border-gray-200');
        } else {
            header.classList.add('bg-white/80', 'border-white/20');
            header.classList.remove('bg-white/95', 'shadow-sm', 'border-gray-200');
        }
    });
});
