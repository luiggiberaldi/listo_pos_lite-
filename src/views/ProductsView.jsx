import React, { useState, useRef } from 'react';
import { storageService } from '../utils/storageService';
import { showToast } from '../components/Toast';
import { Package, Plus, Trash2, X, Store, Tag, Pencil, Banknote, Search, ChevronLeft, ChevronRight, Settings, AlertTriangle, Box } from 'lucide-react';
import { Modal } from '../components/Modal';
import { ProductShareModal } from '../components/ProductShareModal';
import SettingsModal from '../components/SettingsModal';
import ShareInventoryModal from '../components/ShareInventoryModal';
import { formatBs, formatUsd, smartCashRounding } from '../utils/calculatorUtils';
import { useWallet } from '../hooks/useWallet';
import { BODEGA_CATEGORIES, UNITS, CATEGORY_COLORS } from '../config/categories';
import ProductCard from '../components/Products/ProductCard';
import ProductFormModal from '../components/Products/ProductFormModal';
import ConfirmModal from '../components/ConfirmModal';
import CategoryManagerModal from '../components/Products/CategoryManagerModal';
import { useProducts } from '../hooks/useProducts';

export const ProductsView = ({ rates, triggerHaptic }) => {
    // ─── STATE DEL HOOK ─────────────────────────────────────
    const {
        products, setProducts,
        categories, setCategories,
        isLoadingProducts,
        streetRate, setStreetRate,
        useAutoRate, setUseAutoRate,
        customRate, setCustomRate,
        effectiveRate,
        adjustStock: baseAdjustStock
    } = useProducts(rates);

    // Envolver adjsutStock para incluir la respuesta háptica visual
    const adjustStock = (productId, delta) => {
        baseAdjustStock(productId, delta);
        triggerHaptic && triggerHaptic();
    }

    // Modal UI States
    const [isCategoryManagerOpen, setIsCategoryManagerOpen] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isShareOpen, setIsShareOpen] = useState(false);
    const [deleteCategoryConfirmId, setDeleteCategoryConfirmId] = useState(null);

    // Share State
    const [shareProduct, setShareProduct] = useState(null);
    const { accounts } = useWallet();

    // Paginación, Búsqueda y Filtro por Categoría
    const [searchTerm, setSearchTerm] = useState('');
    const [activeCategory, setActiveCategory] = useState('todos');
    const [currentPage, setCurrentPage] = useState(1);
    const ITEMS_PER_PAGE = 8;

    // Form State (Product Edit/Create)
    const [editingId, setEditingId] = useState(null);
    const [name, setName] = useState('');
    const [priceUsd, setPriceUsd] = useState('');
    const [priceBs, setPriceBs] = useState('');
    const [costUsd, setCostUsd] = useState('');
    const [costBs, setCostBs] = useState('');
    const [stock, setStock] = useState('');
    const [unit, setUnit] = useState('unidad');
    const [unitsPerPackage, setUnitsPerPackage] = useState('');
    const [sellByUnit, setSellByUnit] = useState(false);
    const [unitPriceUsd, setUnitPriceUsd] = useState('');
    const [category, setCategory] = useState('otros');
    const [lowStockAlert, setLowStockAlert] = useState('5');
    const [image, setImage] = useState(null);
    // New packaging states
    const [packagingType, setPackagingType] = useState('suelto');
    const [stockInLotes, setStockInLotes] = useState('');
    const [granelUnit, setGranelUnit] = useState('kg');
    const fileInputRef = useRef(null);
    const categoryScrollRef = useRef(null);

    // Form State (Category create)
    const [newCategoryName, setNewCategoryName] = useState('');
    const [newCategoryIcon, setNewCategoryIcon] = useState('📦');

    // Delete State
    const [deleteId, setDeleteId] = useState(null);
    const [isDeleteAllModalOpen, setIsDeleteAllModalOpen] = useState(false);
    const [deleteAllConfirmText, setDeleteAllConfirmText] = useState('');

    // ─── FILTERING & PAGINATION ─────────────────────────────

    const filteredProducts = products.filter(p => {
        const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase());
        if (activeCategory === 'bajo-stock') {
            return matchesSearch && (p.stock ?? 0) <= (p.lowStockAlert ?? 5);
        }
        const matchesCategory = activeCategory === 'todos' || p.category === activeCategory;
        return matchesSearch && matchesCategory;
    });

    const totalPages = Math.ceil(filteredProducts.length / ITEMS_PER_PAGE);
    const paginatedProducts = filteredProducts.slice(
        (currentPage - 1) * ITEMS_PER_PAGE,
        currentPage * ITEMS_PER_PAGE
    );

    // Auto-reset page when filter changes
    // (Linter safe approach instead of an effect calling setState synchronously)
    const handleSetSearchTerm = (term) => {
        setSearchTerm(term);
        setCurrentPage(1);
    }

    const handleSetActiveCategory = (cat) => {
        setActiveCategory(cat);
        setCurrentPage(1);
    }

    // Low stock count
    const lowStockCount = products.filter(p => (p.stock ?? 0) <= (p.lowStockAlert ?? 5) && (p.stock ?? 0) >= 0).length;

    // ─── IMAGE HANDLER ──────────────────────────────────────

    const handleImageUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 400;
                let width = img.width, height = img.height;
                if (width > height) { if (width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; } }
                else { if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; } }
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                setImage(canvas.toDataURL('image/webp', 0.7));
            };
        };
    };

    // ─── HANDLERS BIMONEDA ──────────────────────────────────
    const handlePriceUsdChange = (val) => {
        setPriceUsd(val);
        if (!val || parseFloat(val) <= 0) { setPriceBs(''); return; }
        setPriceBs((parseFloat(val) * effectiveRate).toFixed(2));
    };

    const handlePriceBsChange = (val) => {
        setPriceBs(val);
        if (!val || parseFloat(val) <= 0) { setPriceUsd(''); return; }
        setPriceUsd((parseFloat(val) / effectiveRate).toFixed(2));
    };

    const handleCostUsdChange = (val) => {
        setCostUsd(val);
        if (!val || parseFloat(val) <= 0) { setCostBs(''); return; }
        setCostBs((parseFloat(val) * effectiveRate).toFixed(2));
    };

    const handleCostBsChange = (val) => {
        setCostBs(val);
        if (!val || parseFloat(val) <= 0) { setCostUsd(''); return; }
        setCostUsd((parseFloat(val) / effectiveRate).toFixed(2));
    };

    // ─── CRUD ───────────────────────────────────────────────

    const handleSave = () => {
        triggerHaptic && triggerHaptic();
        if (!name || (!priceUsd && !priceBs)) return showToast('Nombre y precio requeridos', 'warning');

        const formattedName = name.replace(/(^\w{1})|(\s+\w{1})/g, letter => letter.toUpperCase());
        const finalPriceUsd = priceUsd ? parseFloat(priceUsd) : (priceBs ? parseFloat(priceBs) / effectiveRate : 0);
        const finalCostUsd = costUsd ? parseFloat(costUsd) : (costBs ? parseFloat(costBs) / effectiveRate : 0);
        const finalCostBs = costBs ? parseFloat(costBs) : (costUsd ? parseFloat(costUsd) * effectiveRate : 0);

        // Map packagingType → unit legacy
        let legacyUnit = 'unidad';
        if (packagingType === 'lote') legacyUnit = 'paquete';
        else if (packagingType === 'granel') legacyUnit = granelUnit;

        const isLote = packagingType === 'lote';
        const parsedUnitsPerPkg = isLote && unitsPerPackage ? parseInt(unitsPerPackage) : 1;
        const autoUnitPrice = parsedUnitsPerPkg > 1 ? finalPriceUsd / parsedUnitsPerPkg : finalPriceUsd;
        const finalUnitPrice = sellByUnit && unitPriceUsd ? parseFloat(unitPriceUsd) : autoUnitPrice;

        // Stock: for lote, convert lotes → units
        let finalStock = stock ? parseInt(stock) : 0;
        if (isLote && stockInLotes && parsedUnitsPerPkg > 0) {
            finalStock = parseInt(stockInLotes) * parsedUnitsPerPkg;
        }

        const productData = {
            name: formattedName,
            priceUsdt: finalPriceUsd,
            costUsd: finalCostUsd,
            costBs: finalCostBs,
            stock: finalStock,
            unit: legacyUnit,
            packagingType: packagingType,
            unitsPerPackage: parsedUnitsPerPkg,
            sellByUnit: isLote ? sellByUnit : false,
            unitPriceUsd: isLote && sellByUnit ? finalUnitPrice : null,
            stockInLotes: isLote && stockInLotes ? parseInt(stockInLotes) : null,
            category: category,
            lowStockAlert: lowStockAlert ? parseInt(lowStockAlert) : 5,
        };

        if (editingId) {
            setProducts(products.map(p =>
                p.id === editingId ? { ...p, ...productData, image: image || p.image } : p
            ));
        } else {
            setProducts([{
                id: crypto.randomUUID(),
                ...productData,
                image,
                createdAt: new Date().toISOString()
            }, ...products]);
        }
        handleClose();
    };

    const handleEdit = (product) => {
        triggerHaptic && triggerHaptic();
        setEditingId(product.id);
        setName(product.name);

        const currentPriceUsd = product.priceUsdt || 0;
        setPriceUsd(currentPriceUsd > 0 ? currentPriceUsd.toString() : '');
        setPriceBs(currentPriceUsd > 0 ? (currentPriceUsd * effectiveRate).toFixed(2) : '');

        const currentCostUsd = product.costUsd || (product.costBs ? product.costBs / effectiveRate : 0);
        setCostUsd(currentCostUsd > 0 ? currentCostUsd.toFixed(2) : '');

        const currentCostBs = product.costBs || (product.costUsd ? product.costUsd * effectiveRate : 0);
        setCostBs(currentCostBs > 0 ? currentCostBs.toFixed(2) : '');

        setStock(product.stock ?? '');
        setUnit(product.unit || 'unidad');
        setUnitsPerPackage(product.unitsPerPackage || '');
        setSellByUnit(product.sellByUnit || false);
        setUnitPriceUsd(product.unitPriceUsd ? product.unitPriceUsd.toString() : '');
        setCategory(product.category || 'otros');
        setLowStockAlert(product.lowStockAlert ?? 5);
        setImage(product.image);

        // Derive packagingType from legacy unit
        const u = product.unit || 'unidad';
        if (product.packagingType) {
            setPackagingType(product.packagingType);
        } else if (u === 'paquete') {
            setPackagingType('lote');
        } else if (u === 'kg' || u === 'litro') {
            setPackagingType('granel');
            setGranelUnit(u);
        } else {
            setPackagingType('suelto');
        }

        // Stock in lotes
        if (product.stockInLotes) {
            setStockInLotes(product.stockInLotes.toString());
        } else if (u === 'paquete' && product.unitsPerPackage && product.stock) {
            setStockInLotes(Math.floor(product.stock / (product.unitsPerPackage || 1)).toString());
        } else {
            setStockInLotes('');
        }

        if (u === 'kg' || u === 'litro') setGranelUnit(u);

        setIsModalOpen(true);
    };

    const handleDelete = (id) => { triggerHaptic && triggerHaptic(); setDeleteId(id); };
    const confirmDelete = () => {
        if (deleteId) { setProducts(products.filter(p => p.id !== deleteId)); setDeleteId(null); triggerHaptic && triggerHaptic(); }
    };

    const handleClose = () => {
        setName(''); setPriceUsd(''); setPriceBs(''); setCostUsd(''); setCostBs(''); setStock(''); setUnit('unidad'); setUnitsPerPackage(''); setSellByUnit(false); setUnitPriceUsd(''); setCategory('otros'); setLowStockAlert('5'); setImage(null); setEditingId(null); setIsModalOpen(false);
        setPackagingType('suelto'); setStockInLotes(''); setGranelUnit('kg');
    };

    // Gestionar Categorias
    const handleAddCategory = () => {
        if (!newCategoryName.trim()) return;
        const newCat = {
            id: newCategoryName.trim().toLowerCase().replace(/\s+/g, '_'),
            label: newCategoryName.trim(),
            icon: newCategoryIcon,
            color: 'slate'
        };

        // Evitar duplicados
        if (categories.find(c => c.id === newCat.id)) {
            showToast('Esta categoría ya existe', 'warning');
            return;
        }

        setCategories([...categories, newCat]);
        setNewCategoryName('');
        setNewCategoryIcon('📦');
        triggerHaptic && triggerHaptic();
    };

    const handleDeleteCategory = (categoryId) => {
        if (categoryId === 'todos' || categoryId === 'otros') {
            showToast('No puedes eliminar una categoría del sistema', 'warning');
            return;
        }

        const hasProducts = products.some(p => p.category === categoryId);
        if (hasProducts) {
            showToast('No puedes borrar esta categoría porque tiene productos. Cámbialos primero.', 'warning');
            return;
        }

        setDeleteCategoryConfirmId(categoryId);
    };

    const confirmDeleteCategory = () => {
        const categoryId = deleteCategoryConfirmId;
        if (!categoryId) return;
        const newCats = categories.filter(c => c.id !== categoryId);
        setCategories(newCats);
        if (activeCategory === categoryId) handleSetActiveCategory('todos');
        triggerHaptic && triggerHaptic();
        setDeleteCategoryConfirmId(null);
    };

    // ─── RENDER ─────────────────────────────────────────────

    return (
        <div className="flex flex-col h-full bg-slate-50 dark:bg-slate-950 p-3 sm:p-6 overflow-y-auto">

            {/* Header — Fila 1: Título + Acciones */}
            <div className="shrink-0 mb-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <Store size={22} className="text-emerald-500 shrink-0" />
                        <h2 className="text-lg sm:text-2xl font-black text-slate-800 dark:text-white tracking-tight truncate">Inventario</h2>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        {products.length > 0 && (
                            <button onClick={() => { triggerHaptic && triggerHaptic(); setIsDeleteAllModalOpen(true); }}
                                className="p-2 bg-red-100 dark:bg-red-900/30 text-red-500 dark:text-red-400 rounded-xl transition-all active:scale-95" title="Borrar Todo">
                                <Trash2 size={16} strokeWidth={2.5} />
                            </button>
                        )}
                        <button onClick={() => { triggerHaptic && triggerHaptic(); setIsSettingsOpen(true); }}
                            className="p-2 bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-300 rounded-xl transition-all active:scale-95" title="Ajustes">
                            <Settings size={16} strokeWidth={2.5} />
                        </button>
                        <button onClick={() => { triggerHaptic && triggerHaptic(); setIsModalOpen(true); }}
                            className="flex items-center gap-1.5 px-3 py-2 bg-emerald-500 text-white rounded-xl shadow-md shadow-emerald-500/20 transition-all active:scale-95 font-bold text-sm" title="Agregar">
                            <Plus size={16} strokeWidth={2.5} />
                            <span className="hidden sm:inline">Nuevo</span>
                        </button>
                    </div>
                </div>

                {/* Fila 2: Stats clicables */}
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-500 px-2.5 py-1 rounded-full">
                        {products.length} productos
                    </span>
                    {lowStockCount > 0 && (
                        <>
                            <div className="w-px h-4 bg-slate-200 dark:bg-slate-700" />
                            <button
                                onClick={() => { handleSetActiveCategory('bajo-stock'); triggerHaptic && triggerHaptic(); }}
                                className="text-[10px] font-bold bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 px-2.5 py-1 rounded-full flex items-center gap-1 cursor-pointer hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors">
                                ⚠️ {lowStockCount} bajo stock
                            </button>
                        </>
                    )}
                </div>

                {/* Category Filter Pills — horizontal scroll with fade */}
                <div className="relative">
                    <div ref={categoryScrollRef} className="flex gap-1.5 overflow-x-auto pb-1.5 scrollbar-hide -mx-3 px-3 sm:mx-0 sm:px-0 scroll-smooth snap-x">
                        {categories.map(cat => (
                            <button
                                key={cat.id}
                                onClick={() => { handleSetActiveCategory(cat.id); triggerHaptic && triggerHaptic(); }}
                                className={`shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all snap-start border ${activeCategory === cat.id
                                    ? 'bg-emerald-500 text-white shadow-sm shadow-emerald-500/20 border-emerald-500'
                                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-800 active:scale-95'
                                    }`}
                            >
                                {cat.label}
                            </button>
                        ))}
                        <button
                            onClick={() => { triggerHaptic && triggerHaptic(); setIsCategoryManagerOpen(true); }}
                            className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 border border-transparent active:scale-95 flex items-center gap-1 snap-start"
                        >
                            <Settings size={12} /> Editar
                        </button>
                    </div>
                    {/* Right fade indicator for scroll */}
                    <div className="pointer-events-none absolute right-0 top-0 bottom-1.5 w-8 bg-gradient-to-l from-slate-50 dark:from-slate-950 to-transparent sm:hidden" />
                </div>

                {/* Search Bar — slimmer on mobile */}
                <div className="relative">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                        type="text"
                        placeholder="Buscar producto..."
                        value={searchTerm}
                        onChange={(e) => handleSetSearchTerm(e.target.value)}
                        className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 sm:py-3 pl-9 sm:pl-12 pr-4 text-sm text-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-emerald-500/50 shadow-sm"
                    />
                </div>
            </div>

            {/* Product Grid */}
            {isLoadingProducts ? (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-300 dark:text-slate-700 space-y-4">
                    <div className="w-8 h-8 rounded-full border-4 border-slate-200 dark:border-slate-800 border-t-emerald-500 animate-spin" />
                    <p className="text-sm font-medium">Cargando inventario...</p>
                </div>
            ) : products.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-300 dark:text-slate-700 space-y-4">
                    <Package size={64} strokeWidth={1} />
                    <p className="text-sm font-medium">No has agregado productos</p>
                    <p className="text-xs text-slate-400">Toca el botón + para empezar</p>
                </div>
            ) : filteredProducts.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-400 space-y-2">
                    <Search size={48} className="opacity-20" />
                    <p className="text-sm">No se encontraron productos</p>
                </div>
            ) : (
                <>
                    {/* Bajo stock banner */}
                    {activeCategory === 'bajo-stock' && (
                        <div className="flex items-center justify-between bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 px-3 py-2 rounded-xl mb-3 shrink-0">
                            <span className="text-xs font-bold text-amber-600 dark:text-amber-400">Mostrando productos con stock bajo</span>
                            <button onClick={() => handleSetActiveCategory('todos')} className="text-xs font-bold text-amber-500 hover:text-amber-700 transition-colors flex items-center gap-1">
                                × Ver todos
                            </button>
                        </div>
                    )}
                    <div className="flex-1 overflow-y-auto pb-4 scrollbar-hide">
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                            {paginatedProducts.map(p => (
                                <ProductCard
                                    key={p.id}
                                    product={p}
                                    effectiveRate={effectiveRate}
                                    streetRate={streetRate}
                                    categories={categories}
                                    onAdjustStock={adjustStock}
                                    onShare={setShareProduct}
                                    onEdit={handleEdit}
                                    onDelete={handleDelete}
                                />
                            ))}
                        </div>

                        {/* Pagination */}
                        {totalPages > 1 && (
                            <div className="flex justify-center items-center gap-4 py-4 shrink-0">
                                <button onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))} disabled={currentPage === 1}
                                    className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                                    <ChevronLeft size={20} className="text-slate-600 dark:text-slate-400" />
                                </button>
                                <span className="text-sm font-bold text-slate-500 dark:text-slate-400">Página {currentPage} de {totalPages}</span>
                                <button onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))} disabled={currentPage === totalPages}
                                    className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                                    <ChevronRight size={20} className="text-slate-600 dark:text-slate-400" />
                                </button>
                            </div>
                        )}
                    </div>
                </>
            )}

            {/* ─── Modal Añadir / Editar ───────────────────────── */}
            <ProductFormModal
                isOpen={isModalOpen} onClose={handleClose} isEditing={!!editingId}
                image={image} setImage={setImage}
                name={name} setName={setName}
                category={category} setCategory={setCategory}
                unit={unit} setUnit={setUnit}
                priceUsd={priceUsd} handlePriceUsdChange={handlePriceUsdChange}
                priceBs={priceBs} handlePriceBsChange={handlePriceBsChange}
                costUsd={costUsd} handleCostUsdChange={handleCostUsdChange}
                costBs={costBs} handleCostBsChange={handleCostBsChange}
                stock={stock} setStock={setStock}
                lowStockAlert={lowStockAlert} setLowStockAlert={setLowStockAlert}
                unitsPerPackage={unitsPerPackage} setUnitsPerPackage={setUnitsPerPackage}
                sellByUnit={sellByUnit} setSellByUnit={setSellByUnit}
                unitPriceUsd={unitPriceUsd} setUnitPriceUsd={setUnitPriceUsd}
                packagingType={packagingType} setPackagingType={setPackagingType}
                stockInLotes={stockInLotes} setStockInLotes={setStockInLotes}
                granelUnit={granelUnit} setGranelUnit={setGranelUnit}
                effectiveRate={effectiveRate}
                handleImageUpload={handleImageUpload}
                handleSave={handleSave}
                categories={categories}
            />

            {/* Share Modal */}
            <ProductShareModal
                isOpen={!!shareProduct} onClose={() => setShareProduct(null)}
                product={shareProduct} accounts={accounts} streetRate={streetRate}
                rates={{ ...rates, bcv: { ...rates.bcv, price: effectiveRate } }}
            />

            {/* Delete Modal */}
            <Modal isOpen={!!deleteId} onClose={() => setDeleteId(null)} title="Eliminar Producto">
                <div className="flex flex-col items-center text-center space-y-4 py-4">
                    <div className="w-16 h-16 bg-red-50 dark:bg-red-900/20 rounded-full flex items-center justify-center mb-2">
                        <Trash2 size={32} className="text-red-500" />
                    </div>
                    <div>
                        <h4 className="text-lg font-bold text-slate-800 dark:text-white">¿Estás seguro?</h4>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 px-4">Esta acción eliminará el producto permanentemente.</p>
                    </div>
                    <div className="flex gap-3 w-full pt-2">
                        <button onClick={() => setDeleteId(null)} className="flex-1 py-3 text-sm font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors">Cancelar</button>
                        <button onClick={confirmDelete} className="flex-1 py-3 text-sm font-bold text-white bg-red-500 hover:bg-red-600 rounded-xl shadow-lg shadow-red-500/30 active:scale-95 transition-all">¡Sí, eliminar!</button>
                    </div>
                </div>
            </Modal>

            {/* Modal de Confirmación Borrado Total */}
            <Modal isOpen={isDeleteAllModalOpen} onClose={() => { setIsDeleteAllModalOpen(false); setDeleteAllConfirmText(''); }} title="⚠️ Borrado de Inventario">
                <div className="p-4 flex flex-col items-center text-center">
                    <div className="w-16 h-16 bg-red-100 dark:bg-red-900/40 text-red-500 rounded-full flex items-center justify-center mb-4">
                        <Trash2 size={32} />
                    </div>
                    <h3 className="text-xl font-black text-slate-800 dark:text-white mb-2">¿Estás absolutamente seguro?</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-4 px-2">
                        Esta acción borrará <strong className="text-red-500">{products.length} productos</strong> y no se puede deshacer. (No afectará tu historial de ventas).
                    </p>
                    <div className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 mb-6">
                        <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wide">Para confirmar, escribe "BORRAR":</p>
                        <input
                            type="text"
                            value={deleteAllConfirmText}
                            onChange={(e) => setDeleteAllConfirmText(e.target.value)}
                            placeholder="BORRAR"
                            className="w-full form-input bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-xl px-4 py-3 text-center font-black text-red-500 uppercase tracking-widest focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all outline-none"
                        />
                    </div>
                </div>
                <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex gap-3">
                    <button
                        onClick={() => {
                            triggerHaptic && triggerHaptic();
                            setIsDeleteAllModalOpen(false);
                            setDeleteAllConfirmText('');
                        }}
                        className="flex-1 py-3.5 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-white font-bold rounded-xl active:scale-[0.98] transition-all"
                    >
                        Cancelar
                    </button>
                    <button
                        onClick={() => {
                            triggerHaptic && triggerHaptic();
                            if (deleteAllConfirmText.trim().toUpperCase() === 'BORRAR') {
                                setProducts([]);
                                storageService.removeItem('my_products_v1');
                                setIsDeleteAllModalOpen(false);
                                setDeleteAllConfirmText('');
                            }
                        }}
                        disabled={deleteAllConfirmText.trim().toUpperCase() !== 'BORRAR'}
                        className="flex-1 py-3.5 bg-red-500 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex justify-center items-center gap-2"
                    >
                        <Trash2 size={18} /> Borrar Todo
                    </button>
                </div>
            </Modal>

            <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} onImport={() => setIsShareOpen(true)} />

            <ShareInventoryModal
                isOpen={isShareOpen} onClose={() => setIsShareOpen(false)} products={products}
                onImport={(imported) => { setProducts(imported); storageService.setItem('my_products_v1', imported); }}
            />
            <CategoryManagerModal
                isOpen={isCategoryManagerOpen}
                onClose={() => setIsCategoryManagerOpen(false)}
                categories={categories}
                handleAddCategory={handleAddCategory}
                handleDeleteCategory={handleDeleteCategory}
                newCategoryIcon={newCategoryIcon}
                setNewCategoryIcon={setNewCategoryIcon}
                newCategoryName={newCategoryName}
                setNewCategoryName={setNewCategoryName}
            />

            {/* Modal Confirmación: Borrar Categoría */}
            <ConfirmModal
                isOpen={!!deleteCategoryConfirmId}
                onClose={() => setDeleteCategoryConfirmId(null)}
                onConfirm={confirmDeleteCategory}
                title="Eliminar categoría"
                message="¿Seguro que deseas borrar esta categoría? Los productos no se eliminarán, pero quedarán sin categoría asignada."
                confirmText="Sí, eliminar"
                variant="warning"
            />
        </div>
    );
};

export default ProductsView;
