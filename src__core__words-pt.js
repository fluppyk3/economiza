// Vocabulário de produtos comuns em português (sem acentos, minúsculas).
// USO: apenas como SINAL POSITIVO (reforça a confiança de um nome) e para sugerir
// correções de leitura ("Chocolote" -> "Chocolate"). Nunca é usado para REJEITAR um nome:
// marcas novas, abreviações e nomes incomuns continuam aceitos pela análise estrutural.
const RAW = `
leite integral desnatado semidesnatado condensado pasteurizado uht po fermentado coalhada
arroz feijao preto carioca branco cafe acucar cristal refinado mascavo sal grosso marinho
oleo soja girassol milho canola azeite oliva farinha trigo mandioca rosca fuba amido maisena
macarrao espaguete parafuso penne talharim lasanha massa instantaneo miojo
biscoito bolacha recheado cream cracker maisena salgado doce wafer rosquinha torrada bolo
chocolate achocolatado cacau bombom barra granulado confeito sorvete picole gelato pudim gelatina
iogurte queijo mussarela mucarela prato minas parmesao provolone ricota cottage requeijao cremoso
presunto apresuntado mortadela salame peito peru linguica salsicha bacon calabresa hamburguer nugget
manteiga margarina creme chantilly nata
carne bovina suina patinho acém acem alcatra picanha contrafile costela coxao maminha fraldinha moida
frango coxa sobrecoxa asa file peixe tilapia sardinha atum salmao bacalhau camarao
ovo ovos pao paes frances forma integral hot dog bisnaguinha
cereal aveia granola flocos barra cereais
suco nectar refresco refrigerante cola guarana laranja limao uva maca abacaxi manga maracuja
agua mineral gas gaseificada coco isotonico energetico cha mate cafe soluvel capsula
cerveja lata long neck vinho tinto seco suave espumante vodka whisky cachaca
detergente sabao liquido barra amaciante desinfetante alvejante sanitaria esponja multiuso limpador
papel higienico toalha guardanapo cozinha folha dupla neutro
shampoo condicionador sabonete creme dental escova pasta desodorante aerosol roll absorvente fralda
lenco umedecido hidratante protetor solar perfume colonia
banana prata nanica maca gala fuji laranja pera limao melancia melao mamao morango abacate
tomate cebola alho batata cenoura beterraba alface repolho brocolis couve abobrinha pimentao pepino
chuchu mandioca inhame abobora milho verde ervilha lentilha grao bico
molho ketchup maionese mostarda vinagre tempero pimenta extrato passata catchup shoyu barbecue
sardinha lata pacote garrafa caixa pet vidro sache refil unidade duzia kit
tradicional original light zero diet sem com lactose gluten natural organico organica premium extra
especial grande pequeno medio familia sabor morango baunilha coco amendoim castanha avela
caju pate pasta amendoim geleia doce leite goiabada marmelada
racao cachorro gato pet areia petisco
pilha bateria lampada led cabo carregador fone ouvido caixa som
smartphone celular notebook computador televisao tv monitor teclado mouse impressora tablet
camiseta camisa calca bermuda meia cueca sapato tenis chinelo sandalia bolsa mochila
cadeira mesa sofa cama colchao travesseiro lencol cobertor toalha banho
tinta parafuso prego martelo chave fenda furadeira cimento argamassa
caderno caneta lapis borracha cola tesoura papel sulfite mochila estojo
vela fosforo isqueiro saco lixo plastico aluminio filme alumínio
copo prato talher faca garfo colher panela frigideira
gelo cubo churrasco carvao tempero sal grosso espeto
trufa trufado tablete bala chiclete goma pirulito drops pastilha menta hortela
cookie brownie cupcake croissant panetone
amaciante lava roupas maquina tirador manchas
`;

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const WORDS_PT = new Set(
  RAW.split(/\s+/).map((w) => fold(w.trim())).filter((w) => w.length >= 2),
);

export function inDictionary(word) {
  return WORDS_PT.has(fold(word));
}
